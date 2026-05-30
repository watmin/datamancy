// SSRF guard: every trust-path fetch must request `redirect: "error"`, so a
// hosting-only attacker's 3xx can never make the kernel emit an attacker-chosen
// outbound request before verification. We assert the OPTION is passed on every
// fetch (the structural mitigation), since a mock fetch can't enact real
// redirect semantics.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchManifestBytes } from "../dist/manifest.js";
import { fetchSignature } from "../dist/signature.js";
import { fetchAndVerify } from "../dist/resources.js";
import { resourceFor } from "./helpers.mjs";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

test("every trust-path fetch requests redirect:error (no SSRF via a 3xx)", async () => {
  const seen = [];
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts);
    return new Response("x");
  };

  await fetchManifestBytes("https://datamancy.dev/manifest.json").catch(() => {});
  await fetchSignature("https://datamancy.dev/manifest.json.sig").catch(() => {});
  await fetchAndVerify(resourceFor("a", "x"), undefined, "https://datamancy.dev/a").catch(
    () => {},
  );

  assert.equal(seen.length, 3, "all three trust-path fetches fired");
  for (const opts of seen) {
    assert.equal(
      opts?.redirect,
      "error",
      "a trust-path fetch did not forbid redirects — SSRF surface open",
    );
  }
});
