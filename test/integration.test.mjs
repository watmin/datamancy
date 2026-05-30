// Network-gated integration — the full chain against the LIVE, real-key-signed
// datamancy.dev. Skips cleanly when offline. Override origin with
// DATAMANCY_TEST_SITE (e.g. a GitHub-raw mirror) to test self-hosting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";

const SITE = process.env.DATAMANCY_TEST_SITE || "https://datamancy.dev";
const noop = () => {};

let online = false;
try {
  const r = await fetch(`${SITE}/.well-known/mcp/manifest.json`, {
    signal: AbortSignal.timeout(8000),
  });
  online = r.ok;
} catch {
  online = false;
}
const gate = online ? false : `${SITE} unreachable — skipping integration`;

test("live: lists, reads, and verifies against the real pinned key", { skip: gate }, async () => {
  const g = new Grimoire({ site: SITE }, noop);
  const manifest = await g.preflight();
  assert.ok(manifest.resources.length >= 1);
  const list = await g.list();
  const grim = list.find((r) => r.name === "grimoire");
  assert.ok(grim, "grimoire spell present");
  const read = await g.read(grim.uri);
  assert.match(read.text, /grimoire/i);
});

test("rejects a uri absent from the verified manifest", { skip: gate }, async () => {
  const g = new Grimoire({ site: SITE }, noop);
  await g.preflight();
  await assert.rejects(
    () => g.read(`${SITE}/evil/SKILL.md`),
    /Unknown resource|Not present/,
  );
});
