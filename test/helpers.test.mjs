// The proof for `test/helpers.mjs` — the layer every other test file composes
// from, and until now the only layer in the suite with no test of its own.
//
// It was not merely untested; it was untestABLE-by-accident. `scripts/verify-
// contract-marks.mjs` mutates `src/` only, so the harness that re-earns every
// contract mark has never pointed at `test/`. Eight single-edit mutations were
// imposed on helpers.mjs and the full suite re-run for each: FOUR left all 180
// tests green. A fixture that can be wrong in four ways without one red is a
// fixture that vouches for nothing, and every assertion in the suite rests on it.
//
// Each survivor is closed below by a test that was itself verified by
// re-imposing the mutation that survived. The other four mutations already went
// red somewhere in the suite and need no test here — this file covers the gaps,
// not the whole surface. Two later tests cover capability rather than a
// survivor: the keypair's own round-trip, and `installFetch`'s `init`
// passthrough (added so the eight files hand-rolling `globalThis.fetch` have a
// layer that can say what they mean).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sha,
  bytesOf,
  resourceFor,
  manifestFor,
  installFetch,
  captureStdout,
  countingStream,
  publicKey,
  privateKey,
  signBytes,
} from "./helpers.mjs";

// ── resourceFor: the hash must describe the body, and `extra` must win ────────

test("resourceFor's sha256 and size DESCRIBE the body it was handed", () => {
  // Everything downstream trusts this: the kernel verifies a fetched body
  // against these two fields, so a fixture whose hash does not match its own
  // body turns every verification test into a tautology.
  const body = "# grimoire\nSTART HERE.";
  const r = resourceFor("grimoire", body);
  assert.equal(r.sha256, sha(Buffer.from(body)));
  assert.equal(r.size, Buffer.byteLength(body));
  assert.equal(r.blob, `blobs/sha256/${r.sha256}`, "the blob path carries the same hash");
});

test("resourceFor's `extra` OVERRIDES the defaults — it is not merged under them", () => {
  // SURVIVOR 1: spreading `...extra` FIRST instead of last silently ignores
  // every override, and the whole suite stayed green — including the test
  // written to prove that authored descriptions disclose staleness, and
  // http.test.mjs's mimeType override.
  const r = resourceFor("spell", "# spell", {
    description: "an authored description",
    mimeType: "image/jpeg",
    size: 999,
  });
  assert.equal(r.description, "an authored description");
  assert.equal(r.mimeType, "image/jpeg", "override beats the text/markdown default");
  assert.equal(r.size, 999, "override beats the computed size");
  assert.equal(r.name, "spell", "un-overridden defaults survive");
});

test("manifestFor's `extra` overrides too — the same spread, the same way", () => {
  const m = manifestFor([], { epoch: 7, previous: "sha256:" + "a".repeat(64) });
  assert.equal(m.epoch, 7);
  assert.equal(m.previous, `sha256:${"a".repeat(64)}`);
  assert.equal(m.schemaVersion, 1, "un-overridden defaults survive");
});

// ── installFetch: the "origin goes dark" fixture ─────────────────────────────

test("installFetch routes null/undefined to a 404 — not to an empty 200", async () => {
  // SURVIVOR 2: `installFetch(() => null)` is the "the origin goes dark"
  // fixture used by the staleness tests. Routing null to a 200-with-no-body
  // instead of a 404 left the suite fully green — the kernel would have been
  // shown a SUCCESSFUL fetch of empty bytes, which is a different failure mode
  // entirely from an unreachable origin, and the tests could not tell.
  const restore = installFetch(() => null);
  try {
    const res = await fetch("https://test.invalid/anything");
    assert.equal(res.status, 404, "null must mean NOT FOUND");
    assert.equal(res.ok, false);
  } finally {
    restore();
  }

  const restoreUndef = installFetch(() => undefined);
  try {
    assert.equal((await fetch("https://test.invalid/x")).status, 404);
  } finally {
    restoreUndef();
  }
});

test("installFetch restores the real fetch, and passes bytes through unchanged", async () => {
  const real = globalThis.fetch;
  const restore = installFetch(() => "hello");
  assert.notEqual(globalThis.fetch, real, "the mock is actually installed");
  assert.equal(await (await fetch("https://test.invalid/x")).text(), "hello");
  restore();
  assert.equal(globalThis.fetch, real, "restore puts the original back by identity");
});

// ── captureStdout: the instrument the CLI tests read through ─────────────────

test("captureStdout RESTORES process.stdout.write even when fn throws", async () => {
  // SURVIVOR 3, and the worst of the four. Dropping the `finally` restore
  // yielded `pass 140 / fail 0` — forty tests vanished from the run with no
  // failure reported, because the runner's own reporter writes to the stdout
  // this helper had permanently replaced. A green summary and a silently
  // truncated suite were indistinguishable.
  const real = process.stdout.write;
  await assert.rejects(
    () => captureStdout(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(
    process.stdout.write,
    real,
    "a throwing fn must still leave stdout as we found it",
  );
});

test("captureStdout captures NON-JSON lines too — it is a capture, not a filter", async () => {
  // SURVIVOR 4: narrowing the filter to lines starting with `{` left the suite
  // green. The CLI tests read their assertions through this helper, so a filter
  // here silently defines what those tests are able to notice — including any
  // stray non-protocol write, which is the exact thing an MCP stdio server must
  // never emit.
  const lines = await captureStdout(async () => {
    process.stdout.write("plain text line\n");
    process.stdout.write('{"jsonrpc":"2.0"}\n');
    process.stdout.write("  \n"); // whitespace-only IS dropped, by contract
  });
  assert.deepEqual(lines, ["plain text line", '{"jsonrpc":"2.0"}']);
});

// ── countingStream: the early-cancellation instrument ────────────────────────

test("countingStream's counter actually MOVES as chunks are pulled", async () => {
  // SURVIVOR 5: the only assertion on this counter in the suite is an upper
  // bound (`pulled <= 6`), which `pulled === 0` satisfies. Never updating the
  // counter left the suite green — so the instrument that proves the body
  // reader cancels EARLY could have been reporting nothing at all.
  const counter = { pulled: 0 };
  const stream = countingStream(4, 8, counter);
  const reader = stream.getReader();
  assert.equal(counter.pulled, 0, "nothing pulled before the first read");
  await reader.read();
  assert.equal(counter.pulled, 1, "one read pulls exactly one chunk");
  await reader.read();
  assert.equal(counter.pulled, 2);
  await reader.cancel();
  assert.equal(counter.pulled, 2, "cancelling pulls no further chunks");
});

test("countingStream yields the declared shape, then closes", async () => {
  const counter = { pulled: 0 };
  const chunks = [];
  for await (const c of countingStream(3, 16, counter)) chunks.push(c);
  assert.equal(chunks.length, 3, "chunkCount chunks");
  assert.deepEqual(chunks.map((c) => c.byteLength), [16, 16, 16], "chunkSize each");
  assert.equal(counter.pulled, 3);
});

// ── the keypair: the hermetic trust root the whole suite verifies against ────

test("the throwaway keypair actually verifies — signBytes over publicKey", async () => {
  // If this pair did not match, every signature test would be asserting that a
  // bad signature is rejected while believing it asserts a good one is accepted.
  const { verify } = await import("node:crypto");
  const bytes = bytesOf(manifestFor([resourceFor("spell", "# spell")]));
  assert.ok(
    verify("sha256", bytes, { key: publicKey, dsaEncoding: "der" }, signBytes(bytes)),
    "the fixture's own signature must verify against the fixture's own public key",
  );
  assert.ok(privateKey, "and the private half is exported for tests that sign by hand");
  assert.equal(
    verify("sha256", Buffer.from("other bytes"), { key: publicKey, dsaEncoding: "der" },
      signBytes(bytes)),
    false,
    "non-vacuity: a signature over different bytes must NOT verify",
  );
});

test("installFetch passes `init` through and awaits an async route", async () => {
  // Both halves are what the eight hand-rolled `globalThis.fetch` assignments
  // exist to get. Without `init` no timeout test can use this layer; without
  // awaiting, no slow-origin test can. Proving them here is what makes routing
  // around the layer unnecessary rather than merely discouraged.
  const seen = [];
  const restore = installFetch(async (url, init) => {
    seen.push({ url, hasSignal: init?.signal instanceof AbortSignal });
    await Promise.resolve();
    return "delivered";
  });
  try {
    const res = await fetch("https://test.invalid/x", {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(await res.text(), "delivered", "an async route resolves to its body");
    assert.deepEqual(seen, [{ url: "https://test.invalid/x", hasSignal: true }]);
  } finally {
    restore();
  }
});
