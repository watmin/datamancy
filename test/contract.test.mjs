// CONTRACT.md claims to be "enforced by tests". This file is where the rules
// that had no enforcing test acquire one.
//
// Each test below was written against a MUTATION: the guard it covers was
// deleted from a scratch copy of src/, and the suite stayed green. That is the
// only honest way to author an enforcement test — a test that passes both with
// and without the guard proves nothing, and the whole point of this file is
// that a rule the document calls a "hard refusal" must go red when the refusal
// is removed.
//
// The worst of them: MAY 5b, "the signature is ALWAYS required and verified
// regardless of what `signed` says". Making verification obey the manifest's
// own `signed` flag left the suite at pass-all, and a manifest carrying the
// bytes "GARBAGE" as its signature was accepted. The guarantee the entire
// package exists to provide was defended by nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Grimoire } from "../dist/grimoire.js";
import { parseManifest, KERNEL_SCHEMA_MAJOR } from "../dist/manifest.js";
import {
  publicKey,
  signBytes,
  bytesOf,
  resourceFor,
  manifestFor,
  installFetch,
} from "./helpers.mjs";

const SITE = "https://test.invalid";
const noop = () => {};
const BODY = "# spell\ncontent";
const SOURCE = `${SITE}/.well-known/mcp/manifest.json`;

/** Parse a manifest object as if it had arrived verified. */
const parse = (obj) => parseManifest(bytesOf(obj), SOURCE);

/** A manifest object with one well-formed resource, plus overrides. */
const good = (extra = {}) => manifestFor([resourceFor("spell", BODY)], extra);

/** Mutate the single resource of an otherwise-good manifest. */
function withResource(patch) {
  const m = good();
  m.resources[0] = { ...m.resources[0], ...patch };
  return m;
}

/** Assert a manifest shape is REFUSED (the contract's "hard refusal"). */
function refuses(label, obj) {
  assert.throws(
    () => parse(obj),
    (err) => {
      assert.match(err.constructor.name, /ManifestShapeError|ManifestSchemaError/, label);
      // A shape failure is verification-class: loud, never a quiet fallback.
      assert.equal(err.severity, "verification", `${label} is verification-class`);
      return true;
    },
    label,
  );
}

// ── MAY 5b — the load-bearing sentence that had no test ─────────────────────

test("the signature is ALWAYS verified — `trust.signed: false` does NOT opt out", async () => {
  // CONTRACT.md: "`tier` and `signed` are decorative metadata — the signature
  // is *always* required and verified regardless of what `signed` says."
  const manifest = good();
  manifest.trust.signed = false; // the publisher tries to opt out
  const bytes = bytesOf(manifest);

  const restore = installFetch((url) => {
    if (url.endsWith("/manifest.json")) return bytes;
    if (url.endsWith("/manifest.json.sig")) return Buffer.from("GARBAGE");
    return BODY;
  });
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    await assert.rejects(
      () => g.preflight(),
      (err) => {
        assert.equal(err.constructor.name, "SignatureInvalidError");
        return true;
      },
      "an unsigned manifest must be refused even when it declares signed:false",
    );
  } finally {
    restore();
  }
});

test("`trust.signed: true` is equally decorative — a bad signature is still refused", async () => {
  // The mirror of the above: the flag cannot grant trust either.
  const bytes = bytesOf(good());
  const restore = installFetch((url) => {
    if (url.endsWith("/manifest.json")) return bytes;
    if (url.endsWith("/manifest.json.sig")) return signBytes(Buffer.from("different bytes"));
    return BODY;
  });
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    await assert.rejects(() => g.preflight(), /signature|Signature/);
  } finally {
    restore();
  }
});

// ── MUST NEVER 2 — the frozen top-level shapes ──────────────────────────────

test("MUST NEVER 2: dropping or retyping trust/serverInfo is a hard refusal", () => {
  refuses("trust absent", { ...good(), trust: undefined });
  refuses("trust.tier retyped", { ...good(), trust: { algorithm: "SHA-256", tier: "2", signed: true } });
  refuses("trust.signed retyped", { ...good(), trust: { algorithm: "SHA-256", tier: 2, signed: "yes" } });
  refuses("trust.algorithm changed", { ...good(), trust: { algorithm: "SHA-512", tier: 2, signed: true } });
  refuses("serverInfo absent", { ...good(), serverInfo: undefined });
  refuses("serverInfo.name absent", { ...good(), serverInfo: { version: "v" } });
  refuses("serverInfo.version absent", { ...good(), serverInfo: { name: "n" } });
  refuses("serverInfo.version retyped", { ...good(), serverInfo: { name: "n", version: 1 } });
  refuses("resources not an array", { ...good(), resources: { spell: {} } });
});

// ── MUST NEVER 3 — the frozen resource shape ────────────────────────────────

test("MUST NEVER 3: every resource field is required and typed", () => {
  refuses("name absent", withResource({ name: undefined }));
  refuses("name retyped", withResource({ name: 42 }));
  refuses("uri absent", withResource({ uri: undefined }));
  refuses("uri retyped", withResource({ uri: { path: "x" } }));
  refuses("blob absent", withResource({ blob: undefined }));
  refuses("mimeType absent", withResource({ mimeType: undefined }));
  refuses("mimeType retyped", withResource({ mimeType: ["text/markdown"] }));
  refuses("sha256 uppercase", withResource({ sha256: "A".repeat(64) }));
  refuses("sha256 short", withResource({ sha256: "ab" }));
  refuses("size absent", withResource({ size: undefined }));
  refuses("size negative", withResource({ size: -1 }));
  refuses("size NaN", withResource({ size: Number.NaN }));
  refuses("size Infinity", withResource({ size: Number.POSITIVE_INFINITY }));
  refuses("size over the 16 MiB ceiling", withResource({ size: 17 * 1024 * 1024 }));
});

test("MUST NEVER 3: resource NAMES are unique — name addresses a spell", () => {
  // `name` is an addressing key for `fetch_spell`. Duplicates would make array
  // ORDER decide which bytes a caller receives, while MAY 7 explicitly permits
  // the website to reorder resources freely. Both cannot be true.
  const m = manifestFor([resourceFor("dup", "A"), resourceFor("dup", "B")]);
  refuses("duplicate resource names", m);
  // The same two spells under distinct names are fine.
  assert.equal(parse(manifestFor([resourceFor("a", "A"), resourceFor("b", "B")])).resources.length, 2);
});

test("MAY 10's premise: uri and blob must be ORIGIN-RELATIVE, or self-hosting leaks", () => {
  // An absolute reference silently escapes DATAMANCY_SITE — an operator who
  // air-gapped on purpose would reach back out to the public origin, with the
  // bytes still reported as verified. The premise is enforced, not assumed.
  refuses("absolute uri", withResource({ uri: "https://datamancy.dev/spell/SKILL.md" }));
  refuses("absolute blob", withResource({ blob: "https://cdn.example/blobs/x" }));
  refuses("protocol-relative uri", withResource({ uri: "//evil.invalid/x" }));
  refuses("non-http scheme", withResource({ uri: "file:///etc/passwd" }));
  // Relative forms still pass.
  assert.ok(parse(withResource({ uri: "spell/SKILL.md" })));
  assert.ok(parse(withResource({ uri: "/spell/SKILL.md" })));
});

test("MAY 7: reordering resources changes nothing — lookup is by name/uri, never position", async () => {
  // The contract permits the website to reorder freely. Nothing tested it, and
  // 1.1.0 made `name` an addressing key, so a reorder became capable of
  // changing which bytes a caller receives.
  const A = resourceFor("alpha", "# alpha");
  const B = resourceFor("beta", "# beta");

  const readBoth = async (order) => {
    const bytes = bytesOf(manifestFor(order));
    const restore = installFetch((url) => {
      if (url.endsWith("/manifest.json")) return bytes;
      if (url.endsWith("/manifest.json.sig")) return signBytes(bytes);
      return `# ${url.split("/").at(-2)}`;
    });
    try {
      const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
      await g.preflight();
      return {
        byName: (await g.readByName("alpha")).fetched.text,
        byUri: (await g.read(`${SITE}/alpha/SKILL.md`)).fetched.text,
        listed: (await g.list()).resources.map((r) => r.name).sort(),
      };
    } finally {
      restore();
    }
  };

  const forward = await readBoth([A, B]);
  const reversed = await readBoth([B, A]);
  assert.deepEqual(forward, reversed, "a legal reorder must be invisible to every lookup");
  assert.equal(forward.byName, "# alpha");
  assert.equal(forward.byUri, "# alpha");
});

// ── MUST NEVER 3a — the declared chain/format fields ────────────────────────

test("MUST NEVER 3a: schemaVersion, previous and epoch must be DECLARED", () => {
  refuses("schemaVersion absent", good({ schemaVersion: undefined }));
  refuses("schemaVersion zero", good({ schemaVersion: 0 }));
  refuses("schemaVersion fractional", good({ schemaVersion: 1.5 }));
  refuses("schemaVersion NaN", good({ schemaVersion: Number.NaN }));
  refuses("previous absent", good({ previous: undefined }));
  refuses("previous malformed", good({ previous: "sha256:nothex" }));
  refuses("previous bare hash", good({ previous: "a".repeat(64) }));
  refuses("epoch absent", good({ epoch: undefined }));
  refuses("epoch negative", good({ epoch: -1 }));
  refuses("epoch NaN", good({ epoch: Number.NaN }));
});

test("a manifest from the FUTURE is refused loud, never guessed at", () => {
  refuses("schemaVersion beyond the kernel", good({ schemaVersion: KERNEL_SCHEMA_MAJOR + 1 }));
});

// ── MUST NEVER 6 — the frozen paths, enforced without a network ─────────────

test("MUST NEVER 6: the live manifest path is frozen at /.well-known/mcp/", async () => {
  // Previously enforced only by two network-gated integration tests: offline,
  // renaming the path shipped green.
  const requested = [];
  const bytes = bytesOf(good());
  const restore = installFetch((url) => {
    requested.push(url);
    if (url.endsWith("/manifest.json")) return bytes;
    if (url.endsWith("/manifest.json.sig")) return signBytes(bytes);
    return BODY;
  });
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    await g.preflight();
    assert.ok(
      requested.includes(`${SITE}/.well-known/mcp/manifest.json`),
      `live manifest path moved: ${JSON.stringify(requested)}`,
    );
    assert.ok(
      requested.includes(`${SITE}/.well-known/mcp/manifest.json.sig`),
      "detached signature must sit beside the manifest",
    );
  } finally {
    restore();
  }
});

test("MUST NEVER 6: a pinned snapshot is read from /manifests/<hash>/", async () => {
  const bytes = bytesOf(good());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const requested = [];
  const restore = installFetch((url) => {
    requested.push(url);
    if (url.endsWith("/manifest.json")) return bytes;
    if (url.endsWith("/manifest.json.sig")) return signBytes(bytes);
    return BODY;
  });
  try {
    const g = new Grimoire({ site: SITE, pinHash: hash, verifyKey: publicKey }, noop);
    await g.preflight();
    assert.ok(
      requested.includes(`${SITE}/manifests/${hash}/manifest.json`),
      `snapshot path moved: ${JSON.stringify(requested)}`,
    );
  } finally {
    restore();
  }
});

// ── MAY 9 — the discovery bounds the document states as facts ───────────────

/** A signed chain of `depth` manifests, newest first, each linking to the next. */
function buildChain(depth) {
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const byHash = new Map();
  let previous = null;
  const hashes = [];
  // Build oldest → newest so each can name its predecessor's hash.
  for (let i = depth - 1; i >= 0; i--) {
    const bytes = bytesOf(
      manifestFor([resourceFor("spell", BODY)], {
        serverInfo: { name: "t", version: `v${i}` },
        previous,
        epoch: depth - i,
      }),
    );
    const hash = sha(bytes);
    byHash.set(hash, bytes);
    previous = `sha256:${hash}`;
    hashes[i] = hash;
  }
  const latest = byHash.get(hashes[0]);
  return {
    labelAt: (depthFromLatest) => `v${depthFromLatest}`,
    route: (url) => {
      if (url === `${SITE}/.well-known/mcp/manifest.json`) return latest;
      if (url === `${SITE}/.well-known/mcp/manifest.json.sig`) return signBytes(latest);
      const m = url.match(/\/manifests\/([0-9a-f]{64})\/manifest\.json(\.sig)?$/);
      if (m) {
        const bytes = byHash.get(m[1]);
        if (!bytes) return null;
        return m[2] ? signBytes(bytes) : bytes;
      }
      return BODY;
    },
  };
}

test("MAY 9: `versions` lists at most the 50 most recent", async () => {
  // The document publishes "50" and "100" as facts; nothing held them, so
  // either could be changed silently.
  const chain = buildChain(60);
  const restore = installFetch(chain.route);
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    assert.equal((await g.listVersions()).length, 50);
  } finally {
    restore();
  }
});

test("MAY 9: DATAMANCY_VERSION resolves a label within the 100 most recent, and no further", async () => {
  const chain = buildChain(120);
  const restore = installFetch(chain.route);
  try {
    const reachable = new Grimoire(
      { site: SITE, version: chain.labelAt(99), verifyKey: publicKey },
      noop,
    );
    await reachable.preflight(); // inside the walk bound

    const tooDeep = new Grimoire(
      { site: SITE, version: chain.labelAt(110), verifyKey: publicKey },
      noop,
    );
    await assert.rejects(() => tooDeep.preflight(), /not found in the manifest chain/);
  } finally {
    restore();
  }
});

