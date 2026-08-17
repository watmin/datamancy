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
 * It's a static website, so this adapter keeps no boot snapshot and has no
 * reload verb. Every list/read fetches the manifest FRESH and verifies it —
 * coalesced within one in-flight window, so N requests overlapping in real time
 * share one fetch and one verify rather than diverging — and content upgrades
 * immediately. The grimoire index is itself a resource,
 * so re-reading it yields the current catalog with no server involvement.
 *
 * Per request:
 *   1. Fetch the manifest bytes + detached signature (live)
 *   2. Verify the signature against the pinned public key — fail → reject
 *   3. Parse + shape-validate the verified bytes
 *   4. resources/list or the list_spells tool → the manifest's resources;
 *      resources/read or the fetch_spell tool → fetch the content, verify
 *      SHA-256 + size against the manifest entry. Two surfaces, one pipeline:
 *      the tools exist for hosts that wire only tools through to the agent.
 *   5. On a transport failure, serve last-known-good from the verified memo
 *      (loud log if the failure was a verification failure, not transport)
 *
 * Boot does one preflight fetch+verify to fail fast on misconfiguration and
 * to seed the memo; it is NOT a cache — serving always re-fetches.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Grimoire } from "./grimoire.js";
import { createGrimoireHandlers } from "./handlers.js";
import { createMcpServer, DEFAULT_PROTOCOL_VERSION } from "./mcp.js";
import type { StdioServer } from "./protocol.js";

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

// stdout is the MCP protocol channel in server mode, but the CLI sub-commands
// (versions/current/help) don't run a server, so they print to stdout freely.
function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Consumer-chosen posture, all via env (zero-config by default). The variables
 * and what each does are declared once, in `ENV_VARS` below — this comment
 * used to enumerate them a second time and had no way to stay in step.
 *
 * Read LAZILY, on the first command that needs it — all four, at the same
 * moment, in `theGrimoire()`. At module scope, merely importing this file read
 * the importer's environment and constructed a Grimoire — which THROWS on a
 * malformed `DATAMANCY_PIN`. An import that can fail on the importer's
 * unrelated env is a side effect no importer asked for.
 *
 * `siteOrigin()` exists ONLY to seed that construction. Nothing else reads it:
 * every site the origin is printed asks `theGrimoire().origin()`, because this
 * function and the constructor normalise differently (the constructor strips
 * trailing slashes) and a second derivation is free to disagree with the object
 * that already decided. It did: a trailing slash made `datamancy current`
 * announce a mirror to an operator on the canonical origin.
 */
function siteOrigin(): string {
  return process.env.DATAMANCY_SITE?.trim() || DEFAULT_SITE;
}

let cachedGrimoire: Grimoire | null = null;
function theGrimoire(): Grimoire {
  if (cachedGrimoire) return cachedGrimoire;
  const pinRaw = process.env.DATAMANCY_PIN?.trim();
  const pinHash = pinRaw ? pinRaw.replace(/^sha256:/i, "") : null;
  const version = process.env.DATAMANCY_VERSION?.trim() || null;
  const timeoutRaw = process.env.DATAMANCY_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : null;
  cachedGrimoire = new Grimoire(
    { site: siteOrigin(), pinHash, version, timeoutMs },
    log,
  );
  return cachedGrimoire;
}

async function runVersions(): Promise<void> {
  const versions = await theGrimoire().listVersions();
  out(`${versions.length} version(s) at ${theGrimoire().origin()}, newest first:\n`);
  for (const v of versions) {
    out(`  ${v.version}   sha256:${v.hash}   (${v.resources} spells)`);
  }
  out(`\nFreeze one in your MCP client config "env":`);
  out(`  DATAMANCY_PIN=sha256:<hash>     (exact, recommended)`);
  out(`  DATAMANCY_VERSION=<label>       (friendly, e.g. ${versions[0]?.version ?? "ISO8601"})`);
}

/**
 * Print every path a mirror must serve, for the origin currently configured.
 *
 * A documented self-hosting procedure that ends in `/<spell>/SKILL.md` is not a
 * procedure — expanding `<spell>` requires the manifest, which requires
 * fetching and parsing it by hand. The kernel already holds the verified list,
 * so it can simply say. Output is one path per line, so it pipes.
 */
async function runMirror(): Promise<void> {
  const { manifest, hash } = await theGrimoire().preflight();
  const paths = [
    "/.well-known/mcp/manifest.json",
    "/.well-known/mcp/manifest.json.sig",
    `/manifests/${hash}/manifest.json`,
    `/manifests/${hash}/manifest.json.sig`,
    ...manifest.resources.flatMap((r) => [`/${r.uri}`, `/${r.blob}`]),
  ];
  for (const p of paths) out(p.replace(/\/{2,}/g, "/"));
  // Only the CURRENT snapshot. A consumer pinning an OLDER version by hash
  // needs that snapshot too, and this cannot know which they pinned — so say
  // so rather than let a mirror built from this output 404 their pin.
  log(
    `listed ${paths.length} paths for the CURRENT version (sha256:${hash}). ` +
      `This is NOT the whole origin: the older /manifests/<hash>/ snapshots are ` +
      `omitted, so a mirror built from this list alone serves 1 version — ` +
      `\`datamancy versions\` truncates to it and DATAMANCY_VERSION resolves no ` +
      `label but the current one. Mirror the snapshots any consumer pins, and ` +
      `the chain depth you want reachable by label.`,
  );
}

/**
 * Report the live head — and, when the consumer is PINNED, say so.
 *
 * `currentVersion()` deliberately reads the live `latest`, not the pinned
 * snapshot: "am I behind?" is the question worth answering, and a pinned
 * consumer already knows their own hash. But this printed that live head with
 * no indication a pin was in force, and then told the operator to freeze it —
 * so someone running `datamancy current` to CHECK their pin was handed a
 * different hash and an instruction to adopt it. The command that exists to
 * confirm a posture must first disclose the posture it is running under.
 */
async function runCurrent(): Promise<void> {
  const g = theGrimoire();
  const v = await g.currentVersion();
  out(`origin:  ${g.origin()}`);
  out(`posture: ${g.describe()}`);
  out(`version: ${v.version}   (the LIVE head at this origin)`);
  out(`hash:    sha256:${v.hash}`);
  out(`spells:  ${v.resources}`);
  if (g.isFrozen()) {
    out(`\nYou are PINNED, so this is NOT what you are serving — it is what the`);
    out(`origin currently publishes, shown so you can see whether you are behind.`);
    out(`Your own pin is unchanged; adopt the hash above only if you mean to move.`);
  }
  out(`\nFreeze this exact grimoire — add to your MCP client config "env":`);
  out(`  "DATAMANCY_PIN": "sha256:${v.hash}"`);
  if (theGrimoire().origin() !== DEFAULT_SITE) {
    out(`\n(That hash is YOUR mirror's, because DATAMANCY_SITE is set — which is`);
    out(` the one you want to pin a mirror to.)`);
  }
}

/**
 * The CLI surface — declared once, dispatched and documented from here.
 *
 * A sub-command used to live in two hand-maintained lists, the `main` dispatch
 * and the `printHelp` usage block, with nothing holding them in agreement.
 * They had already drifted: `--version` was dispatched and never documented,
 * so `datamancy --help` denied the existence of a flag that worked. Both are
 * now derived from this table, and a command that is not in it does not run.
 *
 * The first spelling of each is canonical — the one the help text prints; the
 * rest are accepted aliases.
 */
type Command = {
  readonly names: readonly [string, ...string[]];
  readonly blurb: string;
  readonly run: () => void | Promise<void>;
};

const COMMANDS: readonly Command[] = [
  { names: ["current"], blurb: "show the current version + how to pin it", run: runCurrent },
  { names: ["versions"], blurb: "list available versions (newest first)", run: runVersions },
  { names: ["mirror"], blurb: "list every path a self-hosted mirror must serve", run: runMirror },
  { names: ["--help", "-h", "help"], blurb: "this help", run: () => printHelp() },
  { names: ["--version", "-v", "version"], blurb: "print the package version", run: () => out(PACKAGE_VERSION) },
];

/**
 * The consumer posture, declared once — the third hand-list this file kept.
 * The prose block above `siteOrigin` used to enumerate these too, so an added
 * variable had three places to be written down and typically reached two.
 * A continuation line is an extra entry in `blurb`.
 */
const ENV_VARS: readonly { readonly spec: string; readonly blurb: readonly string[] }[] = [
  { spec: "DATAMANCY_SITE=<origin>", blurb: ["fetch from a self-hosted mirror"] },
  { spec: "DATAMANCY_PIN=sha256:<hash>", blurb: ["freeze to an immutable version"] },
  { spec: "DATAMANCY_VERSION=<label>", blurb: ["freeze to a version by label"] },
  {
    spec: "DATAMANCY_TIMEOUT_MS=<ms>",
    blurb: [
      "SET the cold fetch budget (default 15000;",
      "warm derives from it; smaller LOWERS it,",
      "down to a floor of 1000)",
    ],
  },
];

function printHelp(): void {
  out(`datamancy v${PACKAGE_VERSION} — cryptographically verified static MCP\n`);
  out(`Usage:`);
  const cmdWidth =
    Math.max(...COMMANDS.map((c) => `datamancy ${c.names[0]}`.length)) + 2;
  out(`  ${"datamancy".padEnd(cmdWidth)}run the MCP server over stdio (default)`);
  for (const c of COMMANDS) {
    out(`  ${`datamancy ${c.names[0]}`.padEnd(cmdWidth)}${c.blurb}`);
  }
  out();
  out(`Env (consumer posture):`);
  const envWidth = Math.max(...ENV_VARS.map((e) => e.spec.length)) + 4;
  for (const e of ENV_VARS) {
    const [first, ...rest] = e.blurb;
    out(`  ${e.spec.padEnd(envWidth)}${first}`);
    for (const line of rest) out(`  ${"".padEnd(envWidth)}${line}`);
  }
}

async function runServer(): Promise<void> {
  // When the MCP client closes the stdio pipe, a pending stdout write surfaces
  // EPIPE as an async error event. With no listener that becomes an uncaught
  // exception — noise that looks like a crash. A disconnect is not a crash:
  // there's nothing left to serve, so exit cleanly.
  //
  // Installed HERE, not at module scope. At module scope an importer inherited
  // a handler that exits THEIR process on THEIR broken pipe — a library that
  // can terminate its host.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  log(`booting v${PACKAGE_VERSION}`);
  log(`origin: ${theGrimoire().origin()}`);
  log(`mode: ${theGrimoire().describe()}`);

  // Preflight: fail fast if the live manifest is unreachable or its
  // signature is invalid at launch. NOT a cache — serving re-fetches.
  const { manifest, hash } = await theGrimoire().preflight();
  log(
    `preflight OK: ${manifest.resources.length} resources, signature ` +
      `VERIFIED against pinned public key`,
  );
  log(`version: ${manifest.serverInfo.version} (sha256:${hash})`);
  // Ask the grimoire, don't re-read the env. This was a second, independent
  // derivation of the posture — same two variables, parsed again, free to
  // disagree with the object that had already decided (it trims, tolerates a
  // `sha256:` prefix, and rejects a malformed pin; this did none of that).
  if (theGrimoire().isFrozen()) {
    log(`frozen at sha256:${hash} — immutable`);
  } else {
    log(`to FREEZE this grimoire: DATAMANCY_PIN=sha256:${hash}`);
  }

  // The notify thunk forwards to the server created just below; it's only
  // invoked at request time, by which point `server` is assigned.
  let server: StdioServer;
  const handlers = createGrimoireHandlers(
    theGrimoire(),
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    (method) => server.sendNotification(method),
    log,
  );
  server = createMcpServer(handlers);

  log(
    `listening on stdio (MCP ${DEFAULT_PROTOCOL_VERSION}) — ` +
      `manifest fetched fresh per request, content upgrades live`,
  );
  await server.listen();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  // A bare invocation — what an MCP client does — is the only thing that serves.
  if (cmd === undefined) return runServer();

  const match = COMMANDS.find((c) => c.names.includes(cmd));
  if (match) return match.run();

  // An UNRECOGNISED argument is a typo, not a request to serve. Booting the
  // stdio server on it looks exactly like a hang: the process blocks on stdin
  // and says nothing.
  log(`unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 2;
}

/**
 * Run ONLY when this file is the process entry point.
 *
 * `package.json` maps both `bin` and the `.` export here, so without this guard
 * `import("datamancy")` boots a stdio server that blocks on stdin forever — a
 * side effect no importer asked for, and one that hangs anything enumerating
 * the shipped modules. Comparing real paths (not the raw argv) so a symlinked
 * bin — which is exactly how `npx` invokes it — still counts as the entry.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    log("FATAL:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      log(err.stack);
    }
    process.exit(1);
  });
}
