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
 * Trust model: LIVING. The pinned Ed25519 public key (src/pinned-pubkey.ts)
 * is the only constant — it verifies ANY manifest the offline key signs,
 * including ones that don't exist yet. So the website is the content: edit
 * a spell, re-sign, push, and every consumer sees it next call. No manifest
 * hash is pinned; there is no republish-per-spell.
 *
 * It's a static website, so this adapter is stateless: no boot snapshot, no
 * reload verb. Every list/read fetches the manifest FRESH and verifies it,
 * so content upgrades immediately. The grimoire index is itself a resource,
 * so re-reading it yields the current catalog with no server involvement.
 *
 * Per request:
 *   1. Fetch the manifest bytes + detached signature (live)
 *   2. Verify the signature against the pinned public key — fail → reject
 *   3. Parse + shape-validate the verified bytes
 *   4. resources/list → the manifest's resources; resources/read → fetch
 *      the content, verify SHA-256 + size against the manifest entry
 *   5. On a transport failure, serve last-known-good from the verified memo
 *      (loud log if the failure was a verification failure, not transport)
 *
 * Boot does one preflight fetch+verify to fail fast on misconfiguration and
 * to seed the memo; it is NOT a cache — serving always re-fetches.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Grimoire } from "./grimoire.js";
import { createMcpServer, SUPPORTED_PROTOCOL_VERSION } from "./mcp.js";

// The canonical origin. An org can override it (DATAMANCY_SITE) to serve a
// cloned snapshot from its own host — the pinned public key still proves the
// content, so they host the bytes but can't forge them.
const DEFAULT_SITE = "https://datamancy.dev";

const PACKAGE_NAME = "datamancy";

// Derive the version from package.json so the reported version can never
// drift from the published one. npm always ships package.json in the
// tarball regardless of the `files` field, and dist/index.js sits one
// level below it, so `../package.json` resolves in every install.
const PACKAGE_VERSION: string = (() => {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

function log(...args: unknown[]): void {
  // MCP uses stdout for protocol; logs go to stderr.
  console.error(`[${PACKAGE_NAME}]`, ...args);
}

// Consumer-chosen posture, all via env (zero-config by default):
//   DATAMANCY_SITE    — origin to fetch from (default datamancy.dev)
//   DATAMANCY_PIN     — sha256:<manifest-hash> → immutable hash-pin
//   DATAMANCY_VERSION — serverInfo.version → resolved via the signed chain
const site = process.env.DATAMANCY_SITE?.trim() || DEFAULT_SITE;
const pinRaw = process.env.DATAMANCY_PIN?.trim();
const pinHash = pinRaw ? pinRaw.replace(/^sha256:/i, "") : null;
const version = process.env.DATAMANCY_VERSION?.trim() || null;

const grimoire = new Grimoire({ site, pinHash, version }, log);

async function main(): Promise<void> {
  log(`booting v${PACKAGE_VERSION}`);
  log(`origin: ${site}`);
  log(`mode: ${grimoire.describe()}`);

  // Preflight: fail fast if the live manifest is unreachable or its
  // signature is invalid at launch. NOT a cache — serving re-fetches.
  const manifest = await grimoire.preflight();
  log(
    `preflight OK: ${manifest.resources.length} resources, signature ` +
      `VERIFIED against pinned public key, server=` +
      `${manifest.serverInfo.name}@${manifest.serverInfo.version}`,
  );

  const server = createMcpServer({
    serverInfo: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    listResources: async () => {
      const resources = await grimoire.list();
      return {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
          description:
            r.description ??
            `Datamancy spell: ${r.name} (SHA-256 verified at fetch time).`,
        })),
      };
    },
    readResource: async ({ uri }) => {
      const fetched = await grimoire.read(uri);
      return {
        contents: [
          {
            uri: fetched.resource.uri,
            mimeType: fetched.resource.mimeType,
            text: fetched.text,
          },
        ],
      };
    },
  });

  log(
    `listening on stdio (MCP ${SUPPORTED_PROTOCOL_VERSION}) — ` +
      `manifest fetched fresh per request, content upgrades live`,
  );
  await server.listen();
}

main().catch((err) => {
  log("FATAL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    log(err.stack);
  }
  process.exit(1);
});
