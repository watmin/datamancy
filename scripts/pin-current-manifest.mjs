#!/usr/bin/env node
// Build-time helper: fetch the live manifest from datamancy.dev, compute
// its SHA-256, and rewrite src/pinned-manifest-hash.ts with the current
// hash + metadata. Wired into package.json `prepublishOnly`, so every
// `npm publish` re-pins automatically — the pinned hash can never drift
// from what's actually published.
//
// Zero dependencies: node:crypto, node:fs, global fetch (Node 20+).

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MANIFEST_URL = "https://datamancy.dev/.well-known/mcp/manifest.json";

const here = dirname(fileURLToPath(import.meta.url));
const targetFile = join(here, "..", "src", "pinned-manifest-hash.ts");

function fail(msg) {
  console.error(`[pin] FATAL: ${msg}`);
  process.exit(1);
}

const res = await fetch(MANIFEST_URL, {
  headers: { Accept: "application/json" },
}).catch((e) => fail(`fetch failed: ${e}`));

if (!res.ok) fail(`HTTP ${res.status} fetching ${MANIFEST_URL}`);

const bytes = new Uint8Array(await res.arrayBuffer());
const hash = createHash("sha256").update(bytes).digest("hex");

// Pull the manifest version (git short SHA) so the pinned file records
// exactly which published manifest this hash corresponds to.
let version = "unknown";
try {
  version = JSON.parse(Buffer.from(bytes).toString("utf-8")).serverInfo.version;
} catch (e) {
  fail(`live manifest is not valid JSON: ${e}`);
}

// Date stamp for the human-readable header (YYYY-MM-DD).
const captured = new Date().toISOString().slice(0, 10);

const contents = `/**
 * SHA-256 of the manifest at datamancy.dev/.well-known/mcp/manifest.json
 * at the time this version of the npm package was published.
 *
 * The boot sequence hashes the fetched manifest bytes and compares to
 * this constant BEFORE signature verification runs. Mismatch = either
 * the manifest changed and this package needs a republish, OR the
 * manifest was tampered with. Either way: reject.
 *
 * This is Tier 3 of the trust model. Tier 1 (per-resource SHA-256) and
 * Tier 2 (Ed25519 manifest signature) both verify against data that
 * travels with the manifest. Tier 3 verifies against a value baked into
 * the npm package at publish time — so defeating it requires compromising
 * the npm publish chain itself, not just datamancy.dev or the signing key.
 *
 * Updated automatically by scripts/pin-current-manifest.mjs at npm
 * prepublish time (see package.json \`prepublishOnly\`). Forgetting to
 * refresh it is impossible: every \`npm publish\` re-pins.
 *
 * Captured: ${captured}
 * From: ${MANIFEST_URL}
 * Manifest version (git short SHA): ${version}
 */

export const PINNED_MANIFEST_SHA256 =
  "${hash}";
`;

writeFileSync(targetFile, contents);
console.error(
  `[pin] pinned manifest SHA-256 ${hash} (version ${version}) → src/pinned-manifest-hash.ts`,
);
