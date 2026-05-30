#!/usr/bin/env node
/**
 * datamancy — a cryptographically verifiable static MCP server backed by
 * datamancy.dev.
 *
 * Boot sequence (Tier 1 + Tier 2 active; Tier 3 planned):
 *   1. Fetch the manifest BYTES from datamancy.dev/.well-known/mcp/manifest.json
 *   2. Fetch the detached signature from manifest.json.sig
 *   3. Verify the signature against the pinned Ed25519 public key
 *      (src/pinned-pubkey.ts). Fail → exit immediately, content rejected.
 *   4. Parse the verified manifest bytes as JSON, shape-validate
 *   5. (T3 future) Verify the manifest SHA-256 against a hash pinned in
 *      the npm package source (defense-in-depth across the publish chain)
 *   6. Expose each manifest resource as an MCP resource over stdio
 *   7. On resource read: fetch content, SHA-256 + size, verify against
 *      manifest entry. Mismatch → structured error, content NEVER returned.
 *
 * Boots as a stdio MCP server, intended invocation: `npx -y datamancy`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchManifestBytes, parseManifest } from "./manifest.js";
import { fetchSignature, verifyManifestSignature } from "./signature.js";
import { fetchAndVerify } from "./resources.js";

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

  // Step 1: fetch raw manifest bytes
  const manifestBytes = await fetchManifestBytes(MANIFEST_URL);
  log(`manifest fetched: ${manifestBytes.byteLength} bytes`);

  // Step 2: fetch detached signature
  const signatureBytes = await fetchSignature(SIGNATURE_URL);
  log(`signature fetched: ${signatureBytes.byteLength} bytes`);

  // Step 3: verify signature against pinned pubkey (Tier 2)
  verifyManifestSignature(
    manifestBytes,
    signatureBytes,
    MANIFEST_URL,
    SIGNATURE_URL,
  );
  log(`signature VERIFIED against pinned public key`);

  // Step 4: parse + shape-validate the now-trusted manifest
  const manifest = parseManifest(manifestBytes, MANIFEST_URL);
  log(
    `manifest parsed: ${manifest.resources.length} resources, ` +
      `trust=tier${manifest.trust.tier}, signed=${manifest.trust.signed}, ` +
      `server=${manifest.serverInfo.name}@${manifest.serverInfo.version}`,
  );

  // TODO Arc M3: verify SHA-256 of manifestBytes against PINNED_MANIFEST_HASH

  const byUri = new Map(manifest.resources.map((r) => [r.uri, r]));

  const server = new Server(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: manifest.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
        description:
          r.description ??
          `Datamancy spell: ${r.name} (SHA-256 verified at fetch time).`,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("listening on stdio");
}

main().catch((err) => {
  log("FATAL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    log(err.stack);
  }
  process.exit(1);
});
