// The single value the entire trust-on-first-use story rests on: the pinned key
// must match the SHA-256 fingerprint published in the README, the
// datamancer.dev identity card, and the DNS TXT record — the three cross-check
// channels the README names. A freeze-time transcription slip in any of them
// must be a RED BUILD, not a silently self-inconsistent trust root that ships
// forever.
//
// This file previously CLAIMED to do that while comparing the key against a
// hand-copied constant declared here. That is a gate over two hand-lists: the
// constant and the README were written from the same source at the same moment
// and could only ever agree with each other. Replacing the README's fingerprint
// with `deadbeef…` left the whole suite green — the exact slip the guard exists
// to catch, in the one channel a consumer actually reads.
//
// So the fingerprint is no longer declared here. It is DERIVED from the shipped
// key and compared against the channels as they exist: every occurrence in
// README.md, and — network-gated — the live DNS record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTxt } from "node:dns/promises";
import { PINNED_PUBKEY_PEM } from "../dist/pinned-pubkey.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The fingerprint the SHIPPED key actually has. Everything else is compared
 *  against this; nothing is compared against a number typed in a test. */
const fingerprint = createHash("sha256")
  .update(
    createPublicKey({ key: PINNED_PUBKEY_PEM, format: "pem" }).export({
      type: "spki",
      format: "der",
    }),
  )
  .digest("hex");

/** The DNS name the README tells a consumer to query, read OUT of the README so
 *  this test cannot check a different record than the one documented. */
const readme = readFileSync(join(root, "README.md"), "utf-8");
const dnsName = /dig \+short TXT (\S+)/.exec(readme)?.[1];

test("the derivation is real — a 64-hex fingerprint from an actual P-256 key", () => {
  // Non-vacuity: if the export or hash silently produced nothing, every
  // comparison below would be against an empty string.
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});

test("EVERY fingerprint in README.md is the shipped key's — not a stale twin", () => {
  // Scans for any 64-hex run, so a fingerprint added to a new section is
  // covered without anyone remembering to update this test.
  const found = [...readme.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]);
  assert.ok(
    found.length >= 2,
    `expected the README to publish the fingerprint (found ${found.length} 64-hex runs)`,
  );
  const wrong = [...new Set(found)].filter((h) => h !== fingerprint);
  assert.deepEqual(
    wrong,
    [],
    "README publishes a fingerprint the shipped key does not have — a consumer " +
      "following the documented cross-check would distrust a correct install",
  );
});

test("the DNS record the README names carries the shipped key's fingerprint", async (t) => {
  // The third channel, and the only one that lives outside this repo — so it is
  // the one a repo-local guard can never otherwise see. Network-gated: DNS is
  // not always reachable, and CI sets DATAMANCY_REQUIRE_NETWORK=1.
  assert.ok(dnsName, "README no longer documents a `dig +short TXT <name>` command");
  let records;
  try {
    records = (await resolveTxt(dnsName)).map((chunks) => chunks.join(""));
  } catch (err) {
    if (process.env.DATAMANCY_REQUIRE_NETWORK === "1") {
      throw new Error(
        `${dnsName} unresolvable (${err.message}) — and DATAMANCY_REQUIRE_NETWORK=1. ` +
          `This is the only cross-check channel outside this repo.`,
      );
    }
    return t.skip(`${dnsName} unresolvable — skipping (set DATAMANCY_REQUIRE_NETWORK=1 to make this fatal)`);
  }
  const joined = records.join(" ");
  assert.ok(
    joined.includes(fingerprint),
    `the TXT record does not contain the shipped key's fingerprint.\n` +
      `  record(s): ${JSON.stringify(records)}\n  expected to contain: ${fingerprint}`,
  );
});

test("the README's dig example shows what the record ACTUALLY returns", () => {
  // The recipe told the reader the record "holds the bare 64-character hex
  // fingerprint, so the value below should equal the one above, quotes aside",
  // and showed a bare quoted hash. The record is a prefixed key=value pair, so
  // a consumer running the documented command on a GOOD install saw a value
  // that did not equal the one above — and the next line says "do not trust it".
  // The shown output must be the real shape, or the recipe trains the reader to
  // accept a near-miss on the one anchor of trust-on-first-use.
  const shown = /dig \+short TXT \S+\n\s*#\s*(.+)/.exec(readme)?.[1]?.trim();
  assert.ok(shown, "the README's dig example no longer shows expected output");
  assert.ok(
    shown.includes("datamancy-pubkey-sha256="),
    `the example output omits the record's key= prefix, so it cannot match what ` +
      `dig prints. Shown: ${shown}`,
  );
  assert.ok(shown.includes(fingerprint), "the example output must carry the real fingerprint");
});
