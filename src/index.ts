#!/usr/bin/env node
/**
 * datamancy — a cryptographically verifiable static MCP server backed by
 * datamancy.dev.
 *
 * Zero runtime dependencies. Every line of code in the trust-critical
 * path lives in this repo. Node 20+ provides everything we need:
 * node:crypto for ECDSA P-256 + SHA-256, node:readline for stdio framing,
 * global fetch for HTTP.
 *
 * Trust model: LIVING. The pinned ECDSA P-256 public key
 * (src/pinned-pubkey.ts) is the only constant — it verifies ANY manifest the
 * matching key (held non-exportably in AWS KMS) signs, including ones that
 * don't exist yet. So the website is the content: edit a spell, re-sign,
 * push, and every consumer sees it next call. No manifest hash is pinned;
 * there is no republish-per-spell.
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

// When the MCP client closes the stdio pipe, a pending stdout write surfaces
// EPIPE as an async error event. With no listener that becomes an uncaught
// exception — noise that looks like a crash. A disconnect is not a crash:
// there's nothing left to serve, so exit cleanly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

// Consumer-chosen posture, all via env (zero-config by default):
//   DATAMANCY_SITE    — origin to fetch from (default datamancy.dev)
//   DATAMANCY_PIN     — sha256:<manifest-hash> → immutable hash-pin
//   DATAMANCY_VERSION — serverInfo.version → resolved via the signed chain
const site = process.env.DATAMANCY_SITE?.trim() || DEFAULT_SITE;
const pinRaw = process.env.DATAMANCY_PIN?.trim();
const pinHash = pinRaw ? pinRaw.replace(/^sha256:/i, "") : null;
const version = process.env.DATAMANCY_VERSION?.trim() || null;

const grimoire = new Grimoire({ site, pinHash, version }, log);

// stdout is the MCP protocol channel in server mode, but the CLI sub-commands
// (versions/current/help) don't run a server, so they print to stdout freely.
function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

async function runVersions(): Promise<void> {
  const versions = await grimoire.listVersions();
  out(`${versions.length} version(s) at ${site}, newest first:\n`);
  for (const v of versions) {
    out(`  ${v.version}   sha256:${v.hash}   (${v.resources} spells)`);
  }
  out(`\nFreeze one in your MCP client config "env":`);
  out(`  DATAMANCY_PIN=sha256:<hash>     (exact, recommended)`);
  out(`  DATAMANCY_VERSION=<label>       (friendly, e.g. ${versions[0]?.version ?? "ISO8601"})`);
}

async function runCurrent(): Promise<void> {
  const v = await grimoire.currentVersion();
  out(`version: ${v.version}`);
  out(`hash:    sha256:${v.hash}`);
  out(`spells:  ${v.resources}`);
  out(`\nFreeze this exact grimoire — add to your MCP client config "env":`);
  out(`  "DATAMANCY_PIN": "sha256:${v.hash}"`);
}

function printHelp(): void {
  out(`datamancy v${PACKAGE_VERSION} — cryptographically verified static MCP\n`);
  out(`Usage:`);
  out(`  datamancy              run the MCP server over stdio (default)`);
  out(`  datamancy current      show the current version + how to pin it`);
  out(`  datamancy versions     list available versions (newest first)`);
  out(`  datamancy --help       this help\n`);
  out(`Env (consumer posture):`);
  out(`  DATAMANCY_SITE=<origin>        fetch from a self-hosted mirror`);
  out(`  DATAMANCY_PIN=sha256:<hash>    freeze to an immutable version`);
  out(`  DATAMANCY_VERSION=<label>      freeze to a version by label`);
}

async function runServer(): Promise<void> {
  log(`booting v${PACKAGE_VERSION}`);
  log(`origin: ${site}`);
  log(`mode: ${grimoire.describe()}`);

  // Preflight: fail fast if the live manifest is unreachable or its
  // signature is invalid at launch. NOT a cache — serving re-fetches.
  const { manifest, hash } = await grimoire.preflight();
  log(
    `preflight OK: ${manifest.resources.length} resources, signature ` +
      `VERIFIED against pinned public key`,
  );
  log(`version: ${manifest.serverInfo.version} (sha256:${hash})`);
  if (pinHash || version) {
    log(`frozen at sha256:${hash} — immutable`);
  } else {
    log(`to FREEZE this grimoire: DATAMANCY_PIN=sha256:${hash}`);
  }

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
      const { fetched, setChange } = await grimoire.read(uri);
      // If this cast revealed a spell-SET change since the client last listed,
      // nudge it to re-source the grimoire — the notice lands at point of use.
      // (Only ever non-null in live mode; a frozen pin never changes its set.)
      if (setChange) {
        log(
          `update @ ${setChange.version}: spells added ` +
            `[${setChange.added.join(", ") || "—"}], removed ` +
            `[${setChange.removed.join(", ") || "—"}] — re-source the grimoire.`,
        );
        server.sendNotification("notifications/resources/list_changed");
      }
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

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "versions") return runVersions();
  if (cmd === "current") return runCurrent();
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }
  return runServer(); // default
}

main().catch((err) => {
  log("FATAL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    log(err.stack);
  }
  process.exit(1);
});
