// Rollback protection via the signed monotone `epoch` — the TUF-rollback fix
// that also closes the concurrency last-writer-wins / set-rewind races. A live
// `latest` whose epoch regressed below the highest verified this session is an
// authentic-but-stale replay: refuse it LOUD, serve last-known-good, never let
// it overwrite the memo or rewind the spell set — regardless of arrival order.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";
import {
  bytesOf,
  sha,
  signBytes,
  manifestFor,
  resourceFor,
  bodyResponse,
  publicKey,
  logCollector,
} from "./helpers.mjs";

const SITE = "https://test.invalid";

// newer: epoch 2000, spells {a,b}. older: epoch 1000, spells {a}. Distinct sets
// so a rollback would be visible as a set change if it ever slipped through.
const newer = manifestFor([resourceFor("a", "x"), resourceFor("b", "y")], {
  epoch: 2000,
  serverInfo: { name: "t", version: "NEW" },
});
const older = manifestFor([resourceFor("a", "x")], {
  epoch: 1000,
  serverInfo: { name: "t", version: "OLD" },
});
const evenNewer = manifestFor([resourceFor("a", "x"), resourceFor("b", "y")], {
  epoch: 3000,
  serverInfo: { name: "t", version: "NEWEST" },
});

const real = globalThis.fetch;
let serve = newer;
let delayMs = 0;
function install() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const m = serve;
    if (u.endsWith("/manifest.json.sig")) return bodyResponse(signBytes(bytesOf(m)));
    if (u.endsWith("/manifest.json")) return bodyResponse(bytesOf(m));
    return bodyResponse("x");
  };
}
afterEach(() => {
  globalThis.fetch = real;
  serve = newer;
  delayMs = 0;
});


const live = (log) => new Grimoire({ site: SITE, verifyKey: publicKey }, log);

test("a regressed epoch is REFUSED loud; the memo keeps the newer manifest", async () => {
  install();
  const c = logCollector();
  const g = live(c.log);
  await g.preflight(); // newer (epoch 2000) → high-water 2000
  assert.equal((await g.list()).resources.length, 2);
  serve = older; // mirror replays the stale (epoch 1000) manifest as latest
  const { resources: list } = await g.list();
  assert.equal(list.length, 2, "served last-known-good (newer), NOT the rollback");
  assert.ok(c.loud(), "logged LOUD — a rollback is not silent");
  assert.ok(!c.quiet(), "not misclassified as transport");
});

test("a higher epoch ADVANCES the high-water mark — a later regression to a once-valid epoch is then refused", async () => {
  install();
  const c = logCollector();
  const g = live(c.log);
  await g.preflight(); // accept epoch 2000 → high-water 2000
  serve = evenNewer; // 3000
  assert.equal((await g.list()).resources.length, 2); // accepted → high-water ADVANCES to 3000
  // Same session: epoch 2000 was fine moments ago, but the mark advanced to
  // 3000, so a replay of 2000 is now a refused rollback (this is the half the
  // preflight-baseline tests don't prove — that the mark actually moves).
  serve = newer; // 2000
  assert.equal(
    (await g.list()).resources.length,
    2,
    "served last-known-good (3000), NOT the now-stale 2000",
  );
  assert.ok(c.loud(), "the advance is real — 2000 is now a refused rollback, logged LOUD");
});

test("an EQUAL epoch is ACCEPTED — its content is served, not the memo's", async () => {
  // `doesNotReject` alone could not fail here: a refused load falls back to the
  // memo seeded by preflight(), so the call resolves whichever branch runs.
  // Acceptance is only observable if the re-published manifest DIFFERS.
  const republished = manifestFor(
    [resourceFor("a", "x"), resourceFor("b", "y"), resourceFor("c", "z")],
    { epoch: 2000 }, // the SAME epoch — a same-second re-publish
  );
  const bytes = bytesOf(republished);
  install();
  const g = live(() => {});
  await g.preflight(); // epoch 2000, memo holds 2 resources
  globalThis.fetch = async (url) =>
    bodyResponse(String(url).endsWith(".sig") ? signBytes(bytes) : bytes);
  const list = await g.list();
  assert.equal(
    list.resources.length,
    3,
    "an equal epoch must be accepted — 2 would mean it fell back to the memo",
  );
  assert.equal(list.provenance, "verified", "and accepted means freshly verified");
});

test("concurrent loads of a stale manifest NEVER poison the memo (order-independent)", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // high-water 2000, memo = newer
  serve = older; // every concurrent load now sees the stale manifest
  const results = await Promise.all([g.list(), g.list(), g.list(), g.list()]);
  for (const list of results) {
    assert.equal(
      list.resources.length,
      2,
      "each concurrent call served last-known-good",
    );
  }
  // memo still newer — a final good fetch confirms it was never overwritten
  serve = newer;
  assert.equal((await g.list()).resources.length, 2);
});

test("an OLDER manifest that RESOLVES LATER (slow) is still rejected", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // 2000
  // Genuinely concurrent: a SLOW older load overlapping a FAST newer one, so
  // "resolves later" is relative to something. The previous version set a 40ms
  // delay on a single sequential call — a duration standing in for an
  // interleaving that never happened, and identical to the no-delay test above.
  serve = older;
  delayMs = 40;
  const slow = g.list();
  await new Promise((r) => setImmediate(r));
  serve = newer;
  delayMs = 0;
  const fast = g.list();
  const [slowResult, fastResult] = await Promise.all([slow, fast]);
  assert.equal(slowResult.resources.length, 2, "the slow older load never wins");
  assert.equal(fastResult.resources.length, 2);
  assert.equal((await g.list()).resources.length, 2, "and the memo was not poisoned");
});

test("a pinned LOW-epoch snapshot loads and serves — choosing an old version is legal", async () => {
  // Renamed from "pinned mode is EXEMPT from the rollback check". That title
  // claimed a branch this test cannot reach: pinned mode loads exactly once and
  // then freezes, and the high-water mark starts at -Infinity, so the first
  // load cannot regress regardless of the exemption. Deleting the `mode ===
  // "live"` condition leaves the whole suite green — the branch is defensive,
  // not load-bearing, and the source now says so with a rune.
  //
  // What IS observable, and what this asserts: pinning an epoch far below
  // anything a live session would accept is legal and serves that snapshot.
  const pinned = manifestFor([resourceFor("a", "x")], { epoch: 5 });
  const pinnedBytes = bytesOf(pinned);
  const pinHash = sha(pinnedBytes);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes(`/manifests/${pinHash}/`)) {
      return bodyResponse(u.endsWith(".sig") ? signBytes(pinnedBytes) : pinnedBytes);
    }
    return bodyResponse("x");
  };
  const g = new Grimoire({ site: SITE, pinHash, verifyKey: publicKey }, () => {});
  await assert.doesNotReject(() => g.preflight()); // low epoch, but pinned → no rollback gate
  assert.equal((await g.list()).resources.length, 1);
});

test("a manifest with NO epoch is REJECTED — the gate can never be bypassed", async () => {
  const noEpoch = manifestFor([resourceFor("a", "x")]);
  delete noEpoch.epoch; // a signed-but-epochless manifest must not sail through
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/manifest.json.sig")) return bodyResponse(signBytes(bytesOf(noEpoch)));
    if (u.endsWith("/manifest.json")) return bodyResponse(bytesOf(noEpoch));
    return bodyResponse("x");
  };
  const g = live(() => {});
  await assert.rejects(() => g.preflight());
});
