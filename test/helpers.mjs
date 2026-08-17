// Shared test scaffolding: a throwaway P-256 keypair (injected via verifyKey
// so the trust gate runs hermetically against the real KMS-shaped flow), plus
// manifest/resource builders, a mock-fetch installer, a stdout capture, and the
// network gate the two live-origin files share.
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

/**
 * The bytes each resource row was built from, so an origin fixture can serve
 * the content its manifest actually declares.
 *
 * A manifest row carries only the HASH of its body, so a fixture handed a row
 * cannot reconstruct the content — and one origin helper filled the gap with a
 * `# ${name}` placeholder, whose hash matches nothing. Its doc said it served
 * the resources; it served a tamper, and the only reason no test failed is that
 * those particular spells were never read. Keyed weakly so a discarded row does
 * not pin its body.
 */
const bodies = new WeakMap();

/** The bytes `resourceFor` hashed for this row, or undefined for a row built
 *  by hand. An origin fixture should serve exactly these. */
export const bodyOf = (resource) => bodies.get(resource);

/** A resource entry for `body`, with matching sha256 + size and a blob path. */
export function resourceFor(name, body, extra = {}) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = sha(b);
  const row = {
    name,
    uri: `${name}/SKILL.md`,
    blob: `blobs/sha256/${h}`,
    mimeType: "text/markdown",
    sha256: h,
    size: b.length,
    ...extra,
  };
  bodies.set(row, b);
  return row;
}

/** A well-formed schemaVersion-1 manifest over `resources`. All rigid-required
 *  fields (schemaVersion, previous, epoch) are present; override via `extra`. */
export function manifestFor(resources, extra = {}) {
  return {
    schemaVersion: 1,
    serverInfo: { name: "test", version: "2026-05-30T00-00-00Z" },
    previous: null,
    epoch: 1,
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
 * Install a mock global fetch driven by
 * `routeFn(url, init) -> Response | bytes | string | null | Promise<those>`.
 * null/undefined → 404. Returns a restore function.
 *
 * `init` is passed through and the result is awaited, because without both this
 * helper could not express what its consumers needed: it dropped `init`, so no
 * test involving the `AbortSignal` could use it, and it required a synchronous
 * answer, so no test involving a slow origin could either. Those are exactly
 * the timeout and concurrency properties this kernel most needs proven — and
 * eight files hand-rolled their own `globalThis.fetch` to get them, each rewrite
 * unnamed and unproven. A shared layer that cannot say what its callers mean is
 * a layer they will route around.
 */
export function installFetch(routeFn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = await routeFn(String(url), init);
    if (r === undefined || r === null) {
      return new Response("not found", { status: 404 });
    }
    return bodyResponse(r);
  };
  return () => {
    globalThis.fetch = real;
  };
}

/** Capture everything written to process.stdout during `fn()` as lines. */
export async function captureStdout(fn) {
  // The saved reference is the ORIGINAL, not `.bind(process.stdout)`. The bound
  // copy was never called — it existed only to be restored — and restoring a
  // fresh wrapper instead of the original means stdout is never actually put
  // back: each call left one more bind layer on top of the last. Nothing here
  // invokes it, so the bind was pure accretion.
  const real = process.stdout.write;
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

/**
 * Whether the live origin is reachable — and whether a skip is ALLOWED.
 *
 * A timing probe deciding whether assertions run is a guess that degrades
 * coverage rather than failing: a loaded box samples "offline" and the checks
 * silently vanish. That matters because `.github/workflows/publish.yml` makes
 * `npm test` the sole gate on `npm publish`, so a release run during a blip
 * would go green having never verified anything against signed content.
 *
 * `DATAMANCY_REQUIRE_NETWORK=1` turns the skip into a failure. CI sets it, so a
 * skip is a local convenience and never a silent hole in the publish gate.
 *
 * Returns `false` when online (node:test reads that as "do not skip"), or the
 * skip reason as a string.
 *
 * It lives HERE because it existed twice — thirty lines, doc comment included,
 * duplicated across the two network-gated files and differing by one
 * identifier. Two copies of the rule that decides whether the publish gate's
 * only signed-content coverage runs is one copy too many.
 */
export async function networkGate(live) {
  let online = false;
  try {
    const r = await fetch(`${live}/.well-known/mcp/manifest.json`, {
      signal: AbortSignal.timeout(8000),
    });
    online = r.ok;
  } catch {
    online = false;
  }
  if (online) return false;

  const why = `${live} unreachable`;
  if (process.env.DATAMANCY_REQUIRE_NETWORK === "1") {
    throw new Error(
      `${why} — and DATAMANCY_REQUIRE_NETWORK=1, so these tests may not skip. ` +
        `They are the only coverage of verified, signed content.`,
    );
  }
  return `${why} — skipping (set DATAMANCY_REQUIRE_NETWORK=1 to make this fatal)`;
}

/**
 * Collect a Grimoire's log lines and classify them by REGISTER.
 *
 * `loud` is the verification-failure banner (a tamper is never silent); `quiet`
 * is the transport-failure line (a blip degrades without screaming). The
 * distinction is the contract those tests exist to pin, so the collector that
 * reads it must be one thing.
 *
 * It was two things: `rollback` and `resilience` each defined `logCollector`
 * with the same name and a different `loud` pattern — rollback's also matched
 * /[Rr]ollback/. A reader who learned the helper in one file was wrong in the
 * other. That extra alternative turns out to have been dead: a refused rollback
 * takes the same loud branch as any verification failure, so removing it leaves
 * rollback's tests green (checked, not assumed). One collector, no options.
 */
export function logCollector() {
  const lines = [];
  return {
    log: (...a) => lines.push(a.map(String).join(" ")),
    loud: () => lines.some((l) => /VERIFICATION FAILED|scary/.test(l)),
    quiet: () => lines.some((l) => /transport failure/.test(l)),
    lines: () => [...lines],
  };
}
