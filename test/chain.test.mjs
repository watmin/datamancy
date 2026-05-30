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
