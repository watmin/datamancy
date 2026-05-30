// The cast-time spell-SET change detection (what drives the "re-source the
// grimoire" nudge). Pure logic — hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";

const mk = (names) => ({
  serverInfo: { version: "2026-05-30T00-00-00Z" },
  resources: names.map((n) => ({ name: n })),
});
const key = (names) => [...names].sort().join("\n");

test("no change when the set is the same (order-independent)", () => {
  assert.equal(Grimoire.spellSetDiff(key(["a", "b"]), mk(["b", "a"])), null);
});

test("a content edit (same names) is NOT a set change", () => {
  // same names → same key → null, regardless of hashes (not modeled here)
  assert.equal(Grimoire.spellSetDiff(key(["cernere", "intueri"]), mk(["cernere", "intueri"])), null);
});

test("detects an added spell", () => {
  const d = Grimoire.spellSetDiff(key(["a", "b"]), mk(["a", "b", "c"]));
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.removed, []);
});

test("detects a removed spell", () => {
  const d = Grimoire.spellSetDiff(key(["a", "b", "c"]), mk(["a", "c"]));
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, ["b"]);
});

test("detects simultaneous add + remove", () => {
  const d = Grimoire.spellSetDiff(key(["a", "b"]), mk(["a", "c"]));
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.removed, ["b"]);
});

test("first load (no baseline) is not a change", () => {
  assert.equal(Grimoire.spellSetDiff(null, mk(["a"])), null);
});
