// Concurrent manifest loads: one fetch, one epoch, one answer, one nudge.
//
// The stdio loop does NOT await one request before reading the next
// (`protocol.ts` says so in as many words), and a JSON-RPC batch dispatches
// through `Promise.all`. So N loads are genuinely in flight against one
// Grimoire. Before coalescing, each did its own manifest fetch, signature fetch
// and ECDSA verify — and N loads straddling a publish resolved with DIFFERENT
// epochs, so the later-resolving older one tripped the rollback guard and was
// reported to the operator as "VERIFICATION FAILED … or the content was
// tampered with", and to the model as a staleness notice on bytes that were the
// newest available and had been verified seconds before.
//
// Nothing in the suite forced two loads to overlap, so none of that was visible.
// The overlap needs no delay to force: `loadManifest` publishes its in-flight
// slot synchronously, so calls issued in one tick are already concurrent. What
// it needs is an origin that can serve a DIFFERENT epoch to each fetch — that,
// not timing, is what makes the un-coalesced case diverge.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";
import {
  bytesOf,
  signBytes,
  manifestFor,
  resourceFor,
  installFetch,
  publicKey,
} from "./helpers.mjs";

const SITE = "https://test.invalid";
const noop = () => {};

const v1 = manifestFor([resourceFor("a", "x")], {
  epoch: 1000,
  serverInfo: { name: "t", version: "V1" },
});
const v2 = manifestFor([resourceFor("a", "x"), resourceFor("b", "y")], {
  epoch: 2000,
  serverInfo: { name: "t", version: "V2" },
});

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/**
 * An origin that counts manifest fetches and can serve a DIFFERENT manifest to
 * each one, selected by fetch index.
 *
 * The previous version held every fetch open behind a promise it released after
 * the calls were made, on the theory that the overlap had to be forced. It did
 * not: `loadManifest` publishes its in-flight slot SYNCHRONOUSLY, before its
 * first await, so calls made in one tick coalesce against an instant mock just
 * as well. Deleting every `await held` left all five tests green — an apparatus
 * a next reader would have copied, doing no work.
 *
 * What is actually needed is the ability to serve a different epoch per fetch,
 * because that — not timing — is what makes the un-coalesced case diverge.
 */
function countingOrigin(manifestAt = () => v1) {
  const counts = { manifest: 0, sig: 0, content: 0 };
  const restore = installFetch(async (url) => {
    if (url.endsWith("/manifest.json.sig")) {
      // The signature must cover the SAME manifest this fetch's sibling got.
      // Signatures are requested in parallel with the body, one pair per load,
      // so pairing them by index keeps every pair internally consistent.
      const m = manifestAt(counts.sig++);
      return signBytes(bytesOf(m));
    }
    if (url.endsWith("/manifest.json")) return bytesOf(manifestAt(counts.manifest++));
    counts.content += 1;
    return "x";
  });
  return { counts, restore };
}

test("N concurrent list() calls trigger ONE manifest fetch, not N", async () => {
  const origin = countingOrigin();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);

  // Issued in one tick, so all five are inside loadManifest's in-flight window.
  const results = await Promise.all([g.list(), g.list(), g.list(), g.list(), g.list()]);

  assert.equal(origin.counts.manifest, 1, "one manifest fetch for five concurrent loads");
  assert.equal(origin.counts.sig, 1, "and one signature fetch — one ECDSA verify, not five");
  for (const r of results) {
    assert.equal(r.provenance, "verified");
    assert.deepEqual(r.resources.map((x) => x.name), ["a"]);
  }
});

test("all N concurrent callers agree on provenance — no caller is told 'stale'", async () => {
  // The defect this closes: two callers, identical bytes, OPPOSITE provenance.
  // One saw "verified"; the other got a staleness notice on the newest content
  // in the session, because their loads resolved with different epochs and the
  // later-resolving older one tripped the rollback guard.
  //
  // The fixture has to be able to produce that divergence or the test measures
  // its own mock. So the origin serves the NEWER manifest to the first fetch
  // and an OLDER one to every fetch after it, within a single window. Coalesced,
  // there is only ever a first fetch and all callers agree. Un-coalesced, caller
  // two receives the regressed epoch, is refused, falls back, and reports
  // "last-known-good" while caller one reports "verified".
  const origin = countingOrigin((i) => (i === 0 ? v2 : v1));
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  try {
    const provenances = (await Promise.all([g.list(), g.list(), g.list()])).map(
      (r) => r.provenance,
    );
    assert.deepEqual(provenances, ["verified", "verified", "verified"]);
    assert.equal(origin.counts.manifest, 1, "and the divergent second fetch never happened");
  } finally {
    origin.restore();
  }
});

test("the nudge fires EXACTLY ONCE across N concurrent readers crossing a publish", async () => {
  // Not N (every caller reporting the same change) and not zero (the change
  // eaten by whichever caller advanced the baseline).
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  const first = countingOrigin(() => v1);
  await g.list(); // establishes the baseline at {a}
  first.restore();

  const second = countingOrigin(() => v2); // the origin publishes {a,b}
  const changes = (await Promise.all([g.list(), g.list(), g.list(), g.list()]))
    .map((r) => r.setChange)
    .filter(Boolean);
  second.restore();

  assert.equal(changes.length, 1, `expected exactly one nudge, got ${changes.length}`);
  assert.deepEqual(changes[0].added, ["b"]);
  assert.deepEqual(changes[0].removed, []);
});

test("it is a COALESCER, not a cache — a load after the window fetches again", async () => {
  // The distinction is the whole trust posture: this server re-fetches and
  // re-verifies per request. A slot held after settling would silently turn it
  // into the boot snapshot it promises never to be, and would freeze the spell
  // set for the life of the process.
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  const first = countingOrigin(() => v1);
  await Promise.all([g.list(), g.list()]);
  assert.equal(first.counts.manifest, 1, "the first window coalesced");
  first.restore();

  const second = countingOrigin(() => v2);
  const after = await g.list();
  assert.equal(second.counts.manifest, 1, "a later call fetched FRESH — the slot was released");
  assert.deepEqual(
    after.resources.map((r) => r.name),
    ["a", "b"],
    "and it sees the new publish, so nothing was frozen",
  );
});

test("a REJECTED load is not cached — the next call retries against the origin", async () => {
  // A held rejection would make one transport blip sticky for the whole process.
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  await assert.rejects(() => Promise.all([g.list(), g.list()]));

  const ok = countingOrigin();
  const recovered = await g.list();
  assert.equal(recovered.provenance, "verified", "the very next call reaches the origin again");
  assert.equal(ok.counts.manifest, 1);
});
