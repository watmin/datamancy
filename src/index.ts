#!/usr/bin/env node
/**
 * datamancy — a cryptographically verifiable static MCP server backed by
 * datamancy.dev.
 *
 * Zero runtime dependencies. Every line of code in the trust-critical
 * path lives in this repo. Node 20+ provides everything we need:
 * node:crypto for Ed25519 + SHA-256, node:readline for stdio framing,
 * global fetch for HTTP.
 *
 * Boot sequence (Tier 1 + Tier 2 active; Tier 3 planned):
 *   1. Fetch the manifest BYTES from datamancy.dev/.well-known/mcp/manifest.json
 *   2. Fetch the detached signature from manifest.json.sig
 *   3. Verify the signature against the pinned Ed25519 public key
 *      (src/pinned-pubkey.ts). Fail → exit immediately, content rejected.
 *   4. Parse the verified manifest bytes as JSON, shape-validate
 *   5. (T3 future) Verify the manifest SHA-256 against a hash pinned in
 *      the npm package source
 *   6. Expose each manifest resource as an MCP resource over stdio
 *   7. On resource read: fetch content, SHA-256 + size, verify against
 *      manifest entry. Mismatch → structured error, content NEVER returned.
 */

import { createHash } from "node:crypto";

import { fetchManifestBytes, parseManifest } from "./manifest.js";
import { fetchSignature, verifyManifestSignature } from "./signature.js";
import { fetchAndVerify } from "./resources.js";
import { createMcpServer, SUPPORTED_PROTOCOL_VERSION } from "./mcp.js";
import { PINNED_MANIFEST_SHA256 } from "./pinned-manifest-hash.js";

const MANIFEST_URL = "https://datamancy.dev/.well-known/mcp/manifest.json";
const SIGNATURE_URL = "https://datamancy.dev/.well-known/mcp/manifest.json.sig";

const PACKAGE_NAME = "datamancy";
const PACKAGE_VERSION = "0.0.1";

function log(...args: unknown[]): void {
  // MCP uses stdout for protocol; logs go to stderr.
  console.error(`[${PACKAGE_NAME}]`, ...args);
}

async function main(): Promise<void> {
  log(`booting v${PACKAGE_VERSION}`);
  log(`manifest: ${MANIFEST_URL}`);
  log(`signature: ${SIGNATURE_URL}`);

  const manifestBytes = await fetchManifestBytes(MANIFEST_URL);
  log(`manifest fetched: ${manifestBytes.byteLength} bytes`);

  // Tier 3: the pinned manifest hash is the strongest gate. Defeating it
  // requires compromising the npm publish chain, not merely the website
  // or the signing key. Check it FIRST: it short-circuits an unnecessary
  // signature fetch, and on the common "manifest changed, package stale"
  // case it yields an actionable npm-update message before any crypto runs.
  const actualManifestHash = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (actualManifestHash !== PINNED_MANIFEST_SHA256) {
    throw new Error(
      `Manifest hash mismatch. Expected ${PINNED_MANIFEST_SHA256} ` +
        `(pinned in this npm package), got ${actualManifestHash} ` +
        `(from the live manifest). The manifest at datamancy.dev has ` +
        `changed since this package version was published. Update to the ` +
        `latest: \`npm update datamancy\` or \`npx -y datamancy@latest\`.`,
    );
  }
  log(`manifest SHA-256 matches pinned value (tier 3)`);

  const signatureBytes = await fetchSignature(SIGNATURE_URL);
  log(`signature fetched: ${signatureBytes.byteLength} bytes`);

  verifyManifestSignature(
    manifestBytes,
    signatureBytes,
    MANIFEST_URL,
    SIGNATURE_URL,
  );
  log(`signature VERIFIED against pinned public key`);

  const manifest = parseManifest(manifestBytes, MANIFEST_URL);
  log(
    `manifest parsed: ${manifest.resources.length} resources, ` +
      `trust=tier${manifest.trust.tier}, signed=${manifest.trust.signed}, ` +
      `server=${manifest.serverInfo.name}@${manifest.serverInfo.version}`,
  );

  const byUri = new Map(manifest.resources.map((r) => [r.uri, r]));

  const server = createMcpServer({
    serverInfo: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    listResources: async () => ({
      resources: manifest.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
        description:
          r.description ??
          `Datamancy spell: ${r.name} (SHA-256 verified at fetch time).`,
      })),
    }),
    readResource: async ({ uri }) => {
      const resource = byUri.get(uri);
      if (!resource) {
        throw new Error(
          `Unknown resource: ${uri}. Not present in the verified manifest.`,
        );
      }
      const fetched = await fetchAndVerify(resource);
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: fetched.text,
          },
        ],
      };
    },
  });

  log(`listening on stdio (MCP ${SUPPORTED_PROTOCOL_VERSION})`);
  await server.listen();
}

main().catch((err) => {
  log("FATAL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    log(err.stack);
  }
  process.exit(1);
});
