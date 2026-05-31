// The third-assault fix: resources/list is the MCP refresh primitive, so a
// spell-SET change must be detected on list() — not silently eaten while only
// read() reports it. Drives a real Grimoire across an upstream add.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Grimoire } from "../dist/grimoire.js";
import {
  bytesOf,
  signBytes,
  manifestFor,
  resourceFor,
  bodyResponse,
  publicKey,
} from "./helpers.mjs";

const SITE = "https://test.invalid";
const setA = manifestFor([resourceFor("a", "x")], { epoch: 1 });
const setAB = manifestFor(
  [resourceFor("a", "x"), resourceFor("b", "y")],
  { epoch: 2 }, // epoch advances so rollback protection accepts the newer set
);

const real = globalThis.fetch;
let serve = setA;
afterEach(() => {
  globalThis.fetch = real;
  serve = setA;
});

function install() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/manifest.json.sig")) {
      return bodyResponse(signBytes(bytesOf(serve)));
    }
    if (u.endsWith("/manifest.json")) return bodyResponse(bytesOf(serve));
    if (u.includes("/a/")) return bodyResponse("x"); // resource "a" body
    if (u.includes("/b/")) return bodyResponse("y"); // resource "b" body
    return bodyResponse("content");
  };
}

test("list() surfaces a spell-SET change — the dominant refresh path detects it, not only read()", async () => {
  install();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, () => {});
  await g.preflight(); // baseline {a}

  assert.equal(
    (await g.list()).setChange,
    null,
    "no change on a list of the same set",
  );

  serve = setAB; // a spell is added upstream
  const r = await g.list(); // client re-sources via resources/list
  assert.ok(r.setChange, "list() detected the set change (was silently eaten before the fix)");
  assert.deepEqual(r.setChange.added, ["b"]);
  assert.deepEqual(r.setChange.removed, []);

  // baseline advanced — a following list (or read) sees no further change
  assert.equal((await g.list()).setChange, null);
});

test("a list() that straddles the change, then a read(), does not double-report it", async () => {
  install();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, () => {});
  await g.preflight(); // {a}
  serve = setAB;
  const fromList = await g.list();
  assert.deepEqual(fromList.setChange?.added, ["b"]); // list catches it
  const fromRead = await g.read(`${SITE}/a/SKILL.md`);
  assert.equal(fromRead.setChange, null, "read after list does not re-report the same change");
});
