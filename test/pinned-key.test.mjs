// The single value the entire trust-on-first-use story rests on: the pinned
// key must match the SHA-256 fingerprint published in the README, the
// datamancer.dev identity card, and the DNS TXT record (the three cross-check
// channels the README names). Nothing else enforces that they agree — so a
// freeze-time transcription slip (in the PEM, the docs, or the DNS record) must
// be a RED BUILD here, not a silently self-inconsistent trust root that ships
// forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PINNED_PUBKEY_PEM } from "../dist/pinned-pubkey.js";

// Published across three independent channels (README, datamancer.dev, DNS TXT).
// If you rotate the key (an end-of-life / new-major event), update this AND
// every channel together.
const PUBLISHED_FINGERPRINT =
  "09db7668a3a0ea27c52de060081c0a70584181c02f9eb94eff6941f904b5f12e";

test("the shipped pinned key matches its published SHA-256 fingerprint", () => {
  const der = createPublicKey({ key: PINNED_PUBKEY_PEM, format: "pem" }).export({
    type: "spki",
    format: "der",
  });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  assert.equal(
    fingerprint,
    PUBLISHED_FINGERPRINT,
    "pinned-key fingerprint DRIFT — the shipped key no longer matches the " +
      "fingerprint published in README/datamancer.dev/DNS. Update the key OR " +
      "the published fingerprint in ALL channels together.",
  );
});

test("package.json exposes datamancy/pinned-pubkey — the trust-check's import contract", () => {
  // The README's "compute it yourself" command imports `datamancy/pinned-pubkey`.
  // Guard that contract surface so an exports-map regression at freeze fails the
  // build instead of silently breaking every consumer who runs the trust-check.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const target = pkg.exports?.["./pinned-pubkey"];
  assert.equal(
    target,
    "./dist/pinned-pubkey.js",
    "exports map must expose ./pinned-pubkey for the README trust-check",
  );
  assert.ok(existsSync(join(root, target)), "the exports target must exist on disk");
});
