// The single value the entire trust-on-first-use story rests on: the pinned
// key must match the SHA-256 fingerprint published in the README, CONTRACT,
// the datamancer.dev identity card, and the DNS TXT record. Nothing else
// enforces that they agree — so a freeze-time transcription slip (in the PEM,
// the docs, or the DNS record) must be a RED BUILD here, not a silently
// self-inconsistent trust root that ships forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createHash } from "node:crypto";
import { PINNED_PUBKEY_PEM } from "../dist/pinned-pubkey.js";

// Published across all four independent channels. If you rotate the key (an
// end-of-life / new-major event), update this AND every channel together.
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
      "fingerprint published in README/CONTRACT/datamancer.dev/DNS. Update the " +
      "key OR the published fingerprint in ALL channels together.",
  );
});
