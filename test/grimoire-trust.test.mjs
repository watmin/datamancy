// The grimoire's CONSUMPTION of the trust gate — pin assert, the loud-no-poison
// memo invariant, and pinned-mode blob selection — driven hermetically with a
// throwaway keypair (injected via verifyKey) and a mocked fetch. No network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { Grimoire } from "../dist/grimoire.js";
import { PinMismatchError } from "../dist/errors.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const noop = () => {};

const SITE = "https://test.invalid";
const body = Buffer.from("# cernere\nspell content under test");
const bodyHash = sha(body);

const resource = {
  name: "cernere",
  uri: "cernere/SKILL.md",
  blob: `blobs/sha256/${bodyHash}`,
  mimeType: "text/markdown",
  sha256: bodyHash,
  size: body.length,
};
const manifestObj = {
  schemaVersion: 1,
  serverInfo: { name: "test", version: "2026-05-30T00-00-00Z" },
  previous: null,
  trust: { algorithm: "SHA-256", tier: 2, signed: true },
  resources: [resource],
};
const manifestBytes = Buffer.from(JSON.stringify(manifestObj));
const manifestHash = sha(manifestBytes);
const manifestSig = sign("sha256", manifestBytes, { key: privateKey, dsaEncoding: "der" });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Serve the (validly test-signed) manifest everywhere; content is overridable.
function serve({ content = body, onContentUrl } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/manifest.json")) return new Response(manifestBytes);
    if (u.endsWith("/manifest.json.sig")) return new Response(manifestSig);
    if (onContentUrl) onContentUrl(u);
    return new Response(content);
  };
}

test("live: verifies manifest + content with the injected key", async () => {
  serve();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  await g.preflight();
  const { fetched } = await g.read(`${SITE}/cernere/SKILL.md`);
  assert.equal(fetched.text, body.toString());
});

test("pinned: a manifest whose hash != the pin is REJECTED (PinMismatchError)", async () => {
  serve();
  const g = new Grimoire(
    { site: SITE, pinHash: "0".repeat(64), verifyKey: publicKey },
    noop,
  );
  await assert.rejects(() => g.preflight(), PinMismatchError);
});

test("pinned: the correct pin verifies AND read fetches the immutable blob (not the live uri)", async () => {
  let contentUrl;
  serve({ onContentUrl: (u) => (contentUrl = u) });
  const g = new Grimoire(
    { site: SITE, pinHash: manifestHash, verifyKey: publicKey },
    noop,
  );
  await g.preflight();
  const { fetched } = await g.read(`${SITE}/cernere/SKILL.md`);
  assert.equal(fetched.text, body.toString());
  assert.match(contentUrl, /\/blobs\/sha256\//); // pinned → immutable blob
});

test("a tampered content read serves last-known-good LOUD and never poisons the memo", async () => {
  let loud = false;
  const log = (...a) => {
    if (/VERIFICATION FAILED|scary/.test(a.map(String).join(" "))) loud = true;
  };
  serve();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, log);
  await g.preflight();
  const uri = `${SITE}/cernere/SKILL.md`;
  const first = await g.read(uri); // good → memoized
  assert.equal(first.fetched.text, body.toString());

  // Same length, different bytes → a HASH mismatch (verification), not size.
  serve({ content: Buffer.from("X".repeat(body.length)) });
  const second = await g.read(uri);
  assert.equal(
    second.fetched.text,
    body.toString(),
    "served last-known-good, not the tampered bytes",
  );
  assert.ok(loud, "a verification failure was logged LOUD");
});
