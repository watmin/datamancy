// Resilience invariants on the MANIFEST (trust-root) path — the content path
// is covered in grimoire-trust.test.mjs; this covers the half that wasn't:
//   • a tampered manifest serves last-known-good LOUD and never poisons the memo
//   • a transport blip serves last-known-good QUIETLY
//   • self-host: relative manifest paths resolve to DATAMANCY_SITE
//   • pinned mode loads the manifest exactly once, then freezes
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

const good = manifestFor([resourceFor("cernere", "spell body")]);
const goodBytes = bytesOf(good);
const goodSig = signBytes(goodBytes);
// A signature over DIFFERENT bytes → verifying it against goodBytes fails.
const wrongSig = signBytes(bytesOf(manifestFor([resourceFor("evil", "z")])));

const real = globalThis.fetch;
let mode = "good";
function install() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (mode === "down") return new Response("nope", { status: 503 });
    if (u.endsWith("/manifest.json.sig")) {
      return bodyResponse(mode === "badsig" ? wrongSig : goodSig);
    }
    if (u.endsWith("/manifest.json")) return bodyResponse(goodBytes);
    return bodyResponse("spell body");
  };
}
afterEach(() => {
  globalThis.fetch = real;
  mode = "good";
});

function logCollector() {
  const lines = [];
  const log = (...a) => lines.push(a.map(String).join(" "));
  return {
    log,
    loud: () => lines.some((l) => /VERIFICATION FAILED|scary/.test(l)),
    quiet: () => lines.some((l) => /transport failure/.test(l)),
  };
}

test("a TAMPERED manifest serves last-known-good LOUD, memo not poisoned", async () => {
  install();
  const c = logCollector();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, c.log);
  await g.preflight(); // seeds the good memo
  mode = "badsig";
  const list = await g.list();
  assert.equal(list[0].name, "cernere", "served last-known-good resources");
  assert.ok(c.loud(), "logged LOUD on a verification failure");
  assert.ok(!c.quiet(), "did NOT misclassify the tamper as transport");
  // The memo must still be the GOOD one — a subsequent good fetch confirms it
  // was never overwritten by the tampered bytes.
  mode = "good";
  assert.equal((await g.list())[0].name, "cernere");
});

test("a TRANSPORT failure serves last-known-good QUIETLY (no scary log)", async () => {
  install();
  const c = logCollector();
  const g = new Grimoire({ site: SITE, verifyKey: publicKey }, c.log);
  await g.preflight();
  mode = "down";
  const list = await g.list();
  assert.equal(list[0].name, "cernere");
  assert.ok(c.quiet(), "logged transport fallback");
  assert.ok(!c.loud(), "did NOT cry tamper on a mere transport blip");
});

test("self-host: a relative manifest uri resolves to the configured origin", async () => {
  const MIRROR = "https://mirror.example";
  let contentUrl;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/manifest.json.sig")) return bodyResponse(goodSig);
    if (u.endsWith("/manifest.json")) return bodyResponse(goodBytes);
    contentUrl = u;
    return bodyResponse("spell body");
  };
  const g = new Grimoire({ site: MIRROR, verifyKey: publicKey }, () => {});
  const list = await g.list();
  assert.equal(list[0].uri, `${MIRROR}/cernere/SKILL.md`);
  const { fetched } = await g.read(`${MIRROR}/cernere/SKILL.md`);
  assert.equal(fetched.text, "spell body");
  assert.ok(contentUrl.startsWith(MIRROR), `content fetched from the mirror`);
});

test("pinned mode loads the manifest EXACTLY ONCE, then freezes", async () => {
  const pm = manifestFor([resourceFor("a", "x")]);
  const pmBytes = bytesOf(pm);
  const pmHash = sha(pmBytes);
  const pmSig = signBytes(pmBytes);
  let manifestFetches = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes(`/manifests/${pmHash}/`)) {
      if (u.endsWith(".sig")) return bodyResponse(pmSig);
      manifestFetches += 1;
      return bodyResponse(pmBytes);
    }
    return bodyResponse("x"); // content blob for resource "a"
  };
  const g = new Grimoire(
    { site: SITE, pinHash: pmHash, verifyKey: publicKey },
    () => {},
  );
  await g.preflight();
  await g.list();
  await g.read(`${SITE}/a/SKILL.md`);
  await g.read(`${SITE}/a/SKILL.md`);
  assert.equal(manifestFetches, 1, "frozen manifest fetched once, never re-fetched");
});
