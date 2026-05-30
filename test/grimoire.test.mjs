// Posture selection from config (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";

const noop = () => {};

test("defaults to live mode", () => {
  const g = new Grimoire({ site: "https://datamancy.dev" }, noop);
  assert.match(g.describe(), /LIVE/);
});

test("pinned by hash", () => {
  const h = "a".repeat(64);
  const g = new Grimoire({ site: "https://x", pinHash: h }, noop);
  assert.match(g.describe(), new RegExp(`PINNED sha256:${h}`));
});

test("pinned by version", () => {
  const g = new Grimoire({ site: "https://x", version: "abc1234" }, noop);
  assert.match(g.describe(), /PINNED version:abc1234/);
});

test("rejects a malformed pin", () => {
  assert.throws(
    () => new Grimoire({ site: "https://x", pinHash: "nothex" }, noop),
    /64-char hex/,
  );
});

test("a hash pin takes precedence over a version", () => {
  const h = "c".repeat(64);
  const g = new Grimoire({ site: "https://x", pinHash: h, version: "z" }, noop);
  assert.match(g.describe(), new RegExp(`PINNED sha256:${h}`));
});
