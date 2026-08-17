// The signed manifest chain — the second immutability posture users are told
// to trust ("tamper-evident, like git history"). Pins: walk termination on
// previous:null, newest-first order, version→hash resolution, a missing label,
// and that a hash-broken hop is REJECTED (the tamper-evidence claim itself).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";
import { PinMismatchError } from "../dist/errors.js";
import {
  bytesOf,
  sha,
  signBytes,
  manifestFor,
  resourceFor,
  installFetch,
  bodyResponse,
  publicKey,
} from "./helpers.mjs";

const SITE = "https://test.invalid";
const noop = () => {};
const OLD_V = "2026-05-29T00-00-00Z";
const NEW_V = "2026-05-30T00-00-00Z";

// Build a 2-link chain: older (previous:null) ← newer (previous: olderHash).
const older = manifestFor([resourceFor("a", "x")], {
  serverInfo: { name: "t", version: OLD_V },
});
const olderBytes = bytesOf(older);
const olderHash = sha(olderBytes);

const newer = manifestFor([resourceFor("a", "x"), resourceFor("b", "y")], {
  serverInfo: { name: "t", version: NEW_V },
  previous: `sha256:${olderHash}`,
});
const newerBytes = bytesOf(newer);

/** Route the live manifest (newer) + the older snapshot. `snapshotBytes`
 *  lets a test serve hash-broken bytes at the snapshot URL. */
function chainRoutes(snapshotBytes = olderBytes) {
  const olderSig = signBytes(snapshotBytes);
  const newerSig = signBytes(newerBytes);
  return (u) => {
    if (u.includes(`/manifests/${olderHash}/`)) {
      return bodyResponse(u.endsWith(".sig") ? olderSig : snapshotBytes);
    }
    if (u.endsWith("/manifest.json.sig")) return bodyResponse(newerSig);
    if (u.endsWith("/manifest.json")) return bodyResponse(newerBytes);
    return bodyResponse("content");
  };
}

let restore = () => {};
afterEach(() => restore());

const live = () => new Grimoire({ site: SITE, verifyKey: publicKey }, noop);

test("listVersions walks newest-first and TERMINATES on previous:null", async () => {
  restore = installFetch(chainRoutes());
  const versions = await live().listVersions();
  assert.equal(versions.length, 2, "walked both links, then stopped");
  assert.equal(versions[0].version, NEW_V); // newest first
  assert.equal(versions[1].version, OLD_V);
  assert.equal(versions[0].resources, 2);
  assert.equal(versions[1].hash, olderHash);
});

test("currentVersion reports the live head", async () => {
  restore = installFetch(chainRoutes());
  const v = await live().currentVersion();
  assert.equal(v.version, NEW_V);
});

test("a version label resolves to its manifest hash via the chain (pinned-by-version)", async () => {
  restore = installFetch(chainRoutes());
  const g = new Grimoire(
    { site: SITE, version: OLD_V, verifyKey: publicKey },
    noop,
  );
  const { hash } = await g.preflight();
  assert.equal(hash, olderHash);
  assert.equal(g.describe(), `PINNED sha256:${olderHash}`);
});

test("an unknown version label exhausts the chain → VersionNotFoundError", async () => {
  restore = installFetch(chainRoutes());
  const g = new Grimoire(
    { site: SITE, version: "2999-01-01T00-00-00Z", verifyKey: publicKey },
    noop,
  );
  await assert.rejects(() => g.preflight(), /not found in the manifest chain/);
});

test("a snapshot whose bytes don't hash to the `previous` pointer is REJECTED (tamper-evident)", async () => {
  // Serve validly-signed but DIFFERENT bytes at the older snapshot URL: the
  // hash won't match the `previous` backpointer the walk asserts against.
  const tampered = bytesOf(
    manifestFor([resourceFor("a", "x")], {
      serverInfo: { name: "t", version: OLD_V, evil: true },
    }),
  );
  restore = installFetch(chainRoutes(tampered));
  await assert.rejects(() => live().listVersions(), PinMismatchError);
});

// ── A BROKEN chain: a listing truncates; a lookup and a tamper do not ────────
//
// Measured against the canonical origin, not imagined: `datamancy versions`
// exited 1 and printed NOTHING because one snapshot 17 hops back returned 404.
// Seventeen versions had already been signature-verified and were discarded.
// A listing that answers "HTTP 404" where it could answer "here are the 17 that
// verify, and your chain is broken below them" is the wrong shape for a listing.

/** Serve the live manifest but 404 the older snapshot — a dangling backpointer,
 *  exactly the shape the real origin is in. */
const brokenChain = () =>
  installFetch((u) => {
    if (u.includes(`/manifests/${olderHash}/`)) return null; // 404
    if (u.endsWith("/.well-known/mcp/manifest.json")) return newerBytes;
    if (u.endsWith("/.well-known/mcp/manifest.json.sig")) return signBytes(newerBytes);
    return "x";
  });

test("listVersions TRUNCATES on a dangling backpointer and says so LOUDLY", async () => {
  const lines = [];
  restore = brokenChain();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, (...a) =>
    lines.push(a.map(String).join(" ")),
  );
  const versions = await g.listVersions();
  assert.equal(versions.length, 1, "the one hop that verified is still returned");
  assert.equal(versions[0].version, NEW_V);
  assert.ok(
    lines.some((l) => /chain BROKEN after 1 version/.test(l)),
    `the operator must be told the chain is broken, not just handed a short list: ${lines}`,
  );
});

test("listVersions still THROWS when the very first hop fails — no partial answer", async () => {
  // "The origin is unreachable" must never render as "no versions exist".
  restore = installFetch(() => null);
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  await assert.rejects(() => g.listVersions());
});

test("listVersions still THROWS on a hash-broken hop — a tamper is never truncated", async () => {
  // The distinction the truncation rests on: transport failures degrade,
  // verification failures do not. A short list is not an answer to a tamper.
  restore = installFetch(chainRoutes(bytesOf(manifestFor([resourceFor("z", "z")]))));
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  await assert.rejects(() => g.listVersions(), PinMismatchError);
});

test("a version LOOKUP still throws on a broken chain — it cannot prove absence", async () => {
  // resolveVersion deliberately does not share the truncation: a walk that
  // stopped early has not shown the label is missing, only that it did not
  // reach it. Reporting VersionNotFound there would be a lie.
  restore = brokenChain();
  const g = new Grimoire({ site: SITE, version: OLD_V, verifyKey: publicKey }, noop);
  await assert.rejects(() => g.preflight());
});
