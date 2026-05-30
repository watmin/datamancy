// Shared test scaffolding: a throwaway P-256 keypair (injected via verifyKey
// so the trust gate runs hermetically against the real KMS-shaped flow), plus
// manifest/resource builders, a mock-fetch installer, and a stdout capture.
// Not a test file (no *.test.mjs), so the runner imports it, never runs it.
import {
  generateKeyPairSync,
  sign as nodeSign,
  createHash,
} from "node:crypto";

export const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const bytesOf = (obj) => Buffer.from(JSON.stringify(obj));
export const signBytes = (bytes) =>
  nodeSign("sha256", bytes, { key: privateKey, dsaEncoding: "der" });

/** A resource entry for `body`, with matching sha256 + size and a blob path. */
export function resourceFor(name, body, extra = {}) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = sha(b);
  return {
    name,
    uri: `${name}/SKILL.md`,
    blob: `blobs/sha256/${h}`,
    mimeType: "text/markdown",
    sha256: h,
    size: b.length,
    ...extra,
  };
}

/** A well-formed schemaVersion-1 manifest over `resources`. */
export function manifestFor(resources, extra = {}) {
  return {
    schemaVersion: 1,
    serverInfo: { name: "test", version: "2026-05-30T00-00-00Z" },
    previous: null,
    trust: { algorithm: "SHA-256", tier: 2, signed: true },
    resources,
    ...extra,
  };
}

/** Wrap bytes/string/stream as a 200 Response. */
export function bodyResponse(b, init) {
  if (b instanceof Response) return b;
  return new Response(b, init);
}

/**
 * Install a mock global fetch driven by `routeFn(url) -> Response | bytes |
 * string | null`. null/undefined → 404. Returns a restore function.
 */
export function installFetch(routeFn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = routeFn(String(url));
    if (r === undefined || r === null) {
      return new Response("not found", { status: 404 });
    }
    return bodyResponse(r);
  };
  return () => {
    globalThis.fetch = real;
  };
}

/**
 * Routes for a single live manifest (+ detached signature) and one content
 * body served at any other URL. `manifest` is signed with the throwaway key.
 */
export function singleManifestRoutes({ manifest, content, sig }) {
  const mBytes = bytesOf(manifest);
  const mSig = sig ?? signBytes(mBytes);
  return (u) => {
    if (u.endsWith("/manifest.json.sig")) return bodyResponse(mSig);
    if (u.endsWith("/manifest.json")) return bodyResponse(mBytes);
    return bodyResponse(content ?? "");
  };
}

/** Capture everything written to process.stdout during `fn()` as lines. */
export async function captureStdout(fn) {
  const real = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = real;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/** A web ReadableStream that yields `chunkCount` chunks of `chunkSize` bytes,
 *  counting how many were actually pulled (to prove early cancellation). */
export function countingStream(chunkCount, chunkSize, counter) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunkCount) {
        controller.close();
        return;
      }
      i += 1;
      counter.pulled = i;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
}
