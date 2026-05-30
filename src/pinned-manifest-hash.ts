/**
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
 * prepublish time (see package.json `prepublishOnly`). Forgetting to
 * refresh it is impossible: every `npm publish` re-pins.
 *
 * Captured: 2026-05-30
 * From: https://datamancy.dev/.well-known/mcp/manifest.json
 * Manifest version (git short SHA): 59870ef
 */

export const PINNED_MANIFEST_SHA256 =
  "dedf60f2e02bf047d409c83252533473f1e8c00e1b59111162d0fdef34aa4dde";
