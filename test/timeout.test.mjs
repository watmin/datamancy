// The timeout policy — the numbers CONTRACT.md publishes, and the invariant
// that every fetch carries a deadline.
//
// This file exists because the whole policy was enforced by NOTHING. Eight
// separate mutations left the suite green: halving both constants, ignoring
// `DATAMANCY_TIMEOUT_MS` entirely, deleting the clamp, deleting the warm
// derivation, making the cold/warm selection always return cold, dropping the
// shared deadline from the version walk, and — worst — dropping the signal from
// `loadManifest` and the content fetch, so no fetch was bounded at all.
//
// A published number with nothing behind it is the same defect as a contract
// rule with no test. Each test below pins one of the section's claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";
import { publicKey, signBytes, bytesOf, resourceFor, manifestFor } from "./helpers.mjs";

const SITE = "https://test.invalid";
const noop = () => {};

// rune:vocare(vantage-bypass-test) — `bounds()` reads coldTimeoutMs and
// warmTimeoutMs, which are `private readonly` in TypeScript and reachable only
// because these tests are .mjs and outside tsconfig's include. No consumer can
// observe them: AbortSignal exposes no delay, and `describe()` reports posture
// only. The arithmetic is otherwise measurable solely by wall-clock, which this
// file does exactly once (the rune:mora test below). The bypass buys eight
// deterministic assertions in place of eight timing races.
/** The bounds a Grimoire resolved for a given override. */
const bounds = (timeoutMs) => {
  const g = new Grimoire({ site: SITE, timeoutMs, verifyKey: publicKey }, noop);
  return { cold: g.coldTimeoutMs, warm: g.warmTimeoutMs };
};

test("the published defaults are the defaults — 15s cold, 5s warm", () => {
  // CONTRACT.md: "15 s with no fallback available, 5 s once a verified copy
  // exists". Halving either constant used to change nothing observable.
  assert.deepEqual(bounds(undefined), { cold: 15_000, warm: 5_000 });
  assert.deepEqual(bounds(null), { cold: 15_000, warm: 5_000 });
});

test("the timeoutMs OPTION sets the budget — it does not merely raise it", () => {
  // The documented semantics, and the surprising half: a smaller value LOWERS
  // the default rather than being ignored as "not a raise".
  //
  // Named for the CONSTRUCTOR OPTION, not the env var, because that is what
  // `bounds()` passes. This test was titled "DATAMANCY_TIMEOUT_MS SETS the
  // budget" while reading nothing from the environment — the residual label of
  // a hole that has since been closed at the right vantage
  // (test/process.test.mjs spawns the binary with the env var set). A title
  // naming a door it never opens is how that hole stayed invisible.
  assert.equal(bounds(60_000).cold, 60_000);
  assert.equal(bounds(2_000).cold, 2_000, "2000 lowers the 15s default");
});

test("the warm bound is DERIVED from cold, at the documented ratio", () => {
  // round(cold × 5000/15000), floored at the minimum. The derivation is stated
  // in CONTRACT.md; nothing held it, so warm could silently equal cold.
  assert.equal(bounds(60_000).warm, 20_000);
  assert.equal(bounds(30_000).warm, 10_000);
  assert.equal(bounds(3_000).warm, 1_000, "floored, not 1000/3");
  for (const cold of [15_000, 60_000, 30_000]) {
    const b = bounds(cold);
    assert.ok(b.warm < b.cold, `warm must be the tighter bound (${cold})`);
  }
});

test("both edges are CLAMPED — a bigger request can never yield a smaller budget", () => {
  // AbortSignal.timeout is setTimeout-backed and wraps above 2**31-1, so an
  // operator setting a huge value used to get a ~1ms budget on every fetch:
  // cold boot fails, warm serves last-known-good forever, one Node warning.
  assert.equal(bounds(3_000_000_000).cold, 2_147_483_647, "clamped to what the host can express");
  assert.ok(bounds(3_000_000_000).warm > 0);

  // Below the floor it is clamped, not discarded back to the 15s default —
  // silently giving 30x what was asked is the opposite of the operator's intent.
  assert.equal(bounds(500).cold, 1_000);
  assert.equal(bounds(0).cold, 1_000);
  assert.equal(bounds(-5).cold, 1_000);

  // Unparseable falls back to the documented defaults.
  assert.equal(bounds(Number.NaN).cold, 15_000);
  assert.equal(bounds(Number.POSITIVE_INFINITY).cold, 15_000);
});

test("the override is monotone — never a larger request for a smaller budget", () => {
  // The property the clamp exists to guarantee, stated directly.
  const asks = [1_000, 5_000, 15_000, 60_000, 600_000, 2_147_483_647, 3_000_000_000];
  const got = asks.map((a) => bounds(a).cold);
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i] >= got[i - 1], `ask ${asks[i]} gave ${got[i]}, below ${got[i - 1]}`);
  }
});

// ── Every fetch carries a deadline ──────────────────────────────────────────

/** Install a fetch that records the signal each call received. */
function recordSignals(resources = [resourceFor("spell", "# spell")], extra = {}) {
  const bytes = bytesOf(manifestFor(resources, extra));
  const sig = signBytes(bytes);
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), signal: init?.signal });
    const u = String(url);
    if (u.endsWith("/manifest.json")) return new Response(bytes);
    if (u.endsWith("/manifest.json.sig")) return new Response(sig);
    return new Response("# spell");
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test("EVERY trust-path fetch is bounded — no unbounded call reaches the origin", async () => {
  // The invariant the whole section rests on. Dropping the signal from
  // loadManifest and from the content fetch left the suite entirely green.
  const { seen, restore } = recordSignals();
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    await g.preflight();
    await g.readByName("spell");
    await g.list();
    assert.ok(seen.length >= 3, `expected several fetches, saw ${seen.length}`);
    const unbounded = seen.filter((s) => !(s.signal instanceof AbortSignal));
    assert.deepEqual(
      unbounded.map((s) => s.url),
      [],
      "every fetch must carry an AbortSignal",
    );
  } finally {
    restore();
  }
});

test("a WARM read gets the tighter budget — the selection reaches real behaviour", async () => {
  // rune:mora(calibration) — the duration IS the measurement here. Everything
  // else in this file is deterministic; this one property (that `budget()`'s
  // haveMemo branch actually selects the tighter bound at a live fetch) cannot
  // be observed without a fetch slower than warm and faster than cold. An
  // AbortSignal does not expose its delay, and asserting on the private method
  // would prove the arithmetic without proving it is wired.
  //
  // cold 3000 / warm 1000, origin delay 1800: the cold read has 1.2s of margin,
  // the warm read is 800ms past its bound. Both margins are wide.
  const body = "# spell";
  const bytes = bytesOf(manifestFor([resourceFor("spell", body)]));
  const sig = signBytes(bytes);
  let delayContent = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/manifest.json")) return new Response(bytes);
    if (u.endsWith("/manifest.json.sig")) return new Response(sig);
    if (delayContent) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayContent);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    return new Response(body);
  };
  try {
    const g = new Grimoire({ site: SITE, timeoutMs: 3_000, verifyKey: publicKey }, noop);
    await g.preflight();

    delayContent = 1_800;
    const cold = await g.readByName("spell"); // no memo yet → 3000ms budget
    assert.equal(cold.provenance, "verified", "a 1.8s fetch fits inside the 3s cold budget");
    assert.equal(cold.fetched.text, body);

    const warm = await g.readByName("spell"); // memo exists → 1000ms budget
    assert.equal(
      warm.provenance,
      "last-known-good",
      "the same 1.8s fetch must exceed the 1s warm budget and fall back",
    );
    assert.equal(warm.fetched.text, body, "and the fallback is the verified copy");
  } finally {
    globalThis.fetch = real;
  }
});

test("the version walk shares ONE deadline across all hops", async () => {
  // Per-hop budgets bound each fetch and leave the WALK unbounded: 100 hops x
  // the cold budget is ~25 minutes, which at MCP initialize timescales is the
  // hang this was meant to close.
  const first = resourceFor("spell", "# spell");
  const genesis = bytesOf(manifestFor([first], { serverInfo: { name: "t", version: "v0" } }));
  const { createHash } = await import("node:crypto");
  const genesisHash = createHash("sha256").update(genesis).digest("hex");
  const head = bytesOf(
    manifestFor([first], {
      serverInfo: { name: "t", version: "v1" },
      previous: `sha256:${genesisHash}`,
      epoch: 2,
    }),
  );
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, signal: init?.signal });
    const body = u.includes(genesisHash) ? genesis : head;
    return new Response(u.endsWith(".sig") ? signBytes(body) : body);
  };
  try {
    const g = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
    await g.listVersions();
    const signals = new Set(seen.map((s) => s.signal));
    assert.ok(seen.length >= 4, `expected a multi-hop walk, saw ${seen.length} fetches`);
    assert.equal(
      signals.size,
      1,
      `the whole walk must share one deadline; saw ${signals.size} distinct signals`,
    );
    assert.ok([...signals][0] instanceof AbortSignal);
  } finally {
    globalThis.fetch = real;
  }
});
