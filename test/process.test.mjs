// The package as a PROCESS — spawned, spoken to over stdio, killed.
//
// Everything else in this suite imports `dist/*.js` and calls functions. But a
// consumer never does that: `package.json` declares `bin: datamancy →
// dist/index.js`, and an MCP host spawns it and writes JSON-RPC lines at it.
// 1.1.0 exists BECAUSE of a claim about that spawned process — that a host
// calling `tools/list` gets a catalog rather than `-32601` — and no test stood
// at that vantage, so the wiring in `index.ts` could diverge from the handlers
// every other test exercises and nothing would notice.
//
// NOTE ON HERMETICITY, and why it is not negotiable here.
//
// A spawned process verifies against the PINNED key compiled into `dist/`, and
// the matching private key is non-exportable in KMS. So a local origin cannot
// serve content this process will accept — by design. The obvious shortcut is
// an env var that overrides the verification key for tests; that shortcut is
// refused. A `DATAMANCY_TEST_PUBKEY` door would let anyone who controls the
// environment make the kernel trust their own key, which is precisely the
// compromise the pinned root exists to prevent. A test convenience is not worth
// a trust bypass, and an env var cannot be "test-only" in a shipped binary.
//
// So the split is: everything provable without a valid signature is HERMETIC
// (a local origin, the CLI, stdout discipline, the failure path), and the
// handful of assertions that need genuinely signed content are NETWORK-GATED
// against the real origin and skip cleanly offline — the same posture
// `integration.test.mjs` already takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { networkGate } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const LIVE = process.env.DATAMANCY_TEST_SITE || "https://datamancy.dev";

const offline = await networkGate(LIVE);

/** An origin that answers, but whose manifest this kernel will never accept —
 *  it is not signed by the pinned key. Enough to drive boot to a real, loud
 *  verification failure without any trust-model door. */
function startUnsignedOrigin() {
  const server = createServer((_req, res) => res.end("{}"));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, server }),
    );
  });
}

/** Spawn the bin, write `lines`, collect stdout/stderr until it exits. */
function speak(lines, { site, args = [], env = {}, timeoutMs = 30_000, spawnArgs = null } = {}) {
  return new Promise((resolve, reject) => {
    // `spawnArgs` replaces `[BIN, ...args]` entirely, for the one test that
    // must run node against a script that IMPORTS the bin rather than being it.
    const child = spawn(process.execPath, spawnArgs ?? [BIN, ...args], {
      env: { ...process.env, ...(site ? { DATAMANCY_SITE: site } : {}), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs}ms\nstderr:\n${err}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code, lines: out.split("\n").filter((l) => l.trim()) });
    });
    for (const line of lines) child.stdin.write(JSON.stringify(line) + "\n");
    child.stdin.end();
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "process-test", version: "0" },
  },
};

// ── Hermetic: the process, its CLI, and its failure path ────────────────────

test("--version and --help terminate and document the consumer env", async () => {
  const version = await speak([], { args: ["--version"] });
  assert.equal(version.code, 0);
  assert.match(version.out.trim(), /^\d+\.\d+\.\d+$/);

  const help = await speak([], { args: ["--help"] });
  assert.equal(help.code, 0);
  assert.match(help.out, /DATAMANCY_SITE/, "help documents the consumer env");
  assert.match(help.out, /DATAMANCY_TIMEOUT_MS/, "including the newest one");
});

test("EVERY documented subcommand terminates — none boots a server or hangs", async () => {
  // The previous version of this test was titled "every documented subcommand"
  // and spawned two of five. `current`, `versions` and `mirror` all fetch, so
  // against an origin that cannot be verified they must FAIL — but they must
  // fail by exiting, not by blocking on stdin like the server does.
  //
  // The list is DERIVED from `--help`, not hand-written. A hand-list is the
  // same defect one size smaller: it was correct when typed, and a fourth
  // subcommand would have been enrolled by nobody. `--help` is itself generated
  // from the COMMANDS table that also drives dispatch (src/index.ts), so a
  // command that exists is a command this test spawns.
  const { url, server } = await startUnsignedOrigin();
  try {
    const help = await speak([], { args: ["--help"], timeoutMs: 10_000 });
    const documented = help.out
      .split("\n")
      .map((l) => /^ {2}datamancy (\S+)\s{2,}/.exec(l)?.[1])
      .filter((c) => c && !c.startsWith("-")); // the flags don't fetch
    // Non-vacuity: an empty or mis-parsed list would sail through the loop
    // below having spawned nothing. This pin is deliberate — a NEW subcommand
    // reds it, which is the point: someone must decide whether it fetches (and
    // so belongs in the loop) rather than being silently omitted.
    assert.deepEqual(
      [...documented].sort(),
      ["current", "mirror", "versions"],
      "help parsed to an unexpected command set — the derivation, not the kernel, is what broke",
    );
    for (const cmd of documented) {
      const r = await speak([], { site: url, args: [cmd], timeoutMs: 30_000 });
      assert.notEqual(r.code, 0, `${cmd} must fail against an unverifiable origin`);
      assert.match(r.err, /FATAL/, `${cmd} must say why on stderr`);
      assert.equal(r.lines.length, 0, `${cmd} must print nothing on failure`);
    }
  } finally {
    server.close();
  }
});

test("an unrecognised argument does NOT silently boot a server", async () => {
  // It used to fall through to runServer(), which blocks on stdin and says
  // nothing — a typo was indistinguishable from a hang.
  const bogus = await speak([], { args: ["--not-a-command"], timeoutMs: 10_000 });
  assert.notEqual(bogus.code, 0, "a typo must not look like success");
  assert.match(bogus.err, /unknown command/i);
});

test("boot against an UNSIGNED origin fails loudly and exits non-zero", async () => {
  const { url, server } = await startUnsignedOrigin();
  try {
    const r = await speak([INIT], { site: url, timeoutMs: 30_000 });
    assert.notEqual(r.code, 0, "a kernel that cannot verify must not serve");
    assert.match(r.err, /FATAL/, "the operator is told, on stderr");
    assert.equal(
      r.lines.length,
      0,
      `nothing may reach stdout when boot fails: ${JSON.stringify(r.lines)}`,
    );
  } finally {
    server.close();
  }
});

// ── The env doors, driven through a real spawn ──────────────────────────────
//
// Everything in test/timeout.test.mjs and test/contract.test.mjs passes config
// to the Grimoire CONSTRUCTOR. That leaves the doors themselves — the four
// `process.env` reads in src/index.ts — with no test at all: deleting any of
// them left the whole suite green. The env var is what an operator actually
// writes in their MCP client config, so it is the surface that must hold.

test("DATAMANCY_PIN reaches the kernel — a malformed pin is refused by name", async () => {
  // Observable hermetically: a bad pin fails at construction, before any fetch.
  const r = await speak([INIT], { site: "http://127.0.0.1:1", args: [],
    env: { DATAMANCY_PIN: "not-a-64-char-hex-value" }, timeoutMs: 20_000 });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /DATAMANCY_PIN must be a 64-char hex/,
    "the env value must reach the kernel's own validation");
});

test("DATAMANCY_PIN strips the sha256: prefix the README tells you to paste", async () => {
  // README's worked example is `"DATAMANCY_PIN": "sha256:<hash>"`. The strip at
  // the door is what makes that paste work, and nothing covered it.
  const hex = "a".repeat(64);
  const r = await speak([INIT], { site: "http://127.0.0.1:1", args: [],
    env: { DATAMANCY_PIN: `sha256:${hex}` }, timeoutMs: 20_000 });
  assert.doesNotMatch(r.err, /must be a 64-char hex/,
    "a sha256:-prefixed pin must be accepted, not rejected as malformed");
  assert.match(r.err, /PINNED sha256:/, "and the resolved posture names it");
});

test("DATAMANCY_VERSION reaches the kernel — the posture says so at boot", async () => {
  const r = await speak([INIT], { site: "http://127.0.0.1:1", args: [],
    env: { DATAMANCY_VERSION: "2026-01-01T00-00-00Z" }, timeoutMs: 20_000 });
  assert.match(r.err, /PINNED version:2026-01-01T00-00-00Z/,
    "the env value must reach the posture the kernel reports");
});

test("DATAMANCY_TIMEOUT_MS reaches the kernel — boot bails at the budget it names", async () => {
  // rune:mora(calibration) — the duration IS the measurement. The only
  // observable difference between "the env var is read" and "the env var is
  // ignored" is WHEN a black-hole origin gives up: ~2s if the door works,
  // ~15s (the default) if it does not. A 6s ceiling separates them with margin
  // on both sides, and the assertion is on elapsed time by necessity.
  const server = createServer(() => {}); // accepts, never answers
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = Date.now();
    const r = await speak([INIT], { site: url, env: { DATAMANCY_TIMEOUT_MS: "2000" },
      timeoutMs: 25_000 });
    const elapsed = Date.now() - started;
    assert.notEqual(r.code, 0, "a boot that cannot fetch must not serve");
    assert.ok(elapsed < 6_000,
      `boot took ${elapsed}ms; with the 2s budget honoured it should bail well ` +
      `under 6s, and at the 15s default it would not`);
  } finally {
    server.close();
  }
});

// ── Network-gated: the assertions that need genuinely signed content ────────

test("a SPAWNED server answers tools/list — never -32601", { skip: offline }, async () => {
  const r = await speak([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }], {
    site: LIVE,
  });
  const messages = r.lines.map((l) => JSON.parse(l));
  const tools = messages.find((m) => m.id === 2);
  assert.ok(tools, `no response for tools/list; stderr:\n${r.err}`);
  assert.equal(tools.error, undefined, `tools/list errored: ${JSON.stringify(tools.error)}`);
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ["fetch_spell", "list_spells"]);
});

test("a SPAWNED server serves both mouths, and they agree", { skip: offline }, async () => {
  const r = await speak(
    [
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spells", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch_spell", arguments: { spell: "grimoire" } } },
      { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `${LIVE}/grimoire/SKILL.md` } },
    ],
    { site: LIVE },
  );
  const by = Object.fromEntries(
    r.lines.map((l) => JSON.parse(l)).filter((m) => m.id).map((m) => [m.id, m]),
  );
  assert.match(by[2].result.content[0].text, /^grimoire — /m, "the catalog lists the index spell");
  assert.equal(
    by[3].result.content[0].text,
    by[4].result.contents[0].text,
    "the two mouths must return identical bytes through a real process",
  );
});

test("the spawned server writes ONLY JSON-RPC to stdout", { skip: offline }, async () => {
  // MCP stdio: the server MUST NOT write anything to stdout that is not a valid
  // MCP message. The boot banner is chatty, so this is a live risk.
  const r = await speak([INIT], { site: LIVE });
  assert.ok(r.lines.length >= 1, `no stdout at all; stderr:\n${r.err}`);
  for (const line of r.lines) {
    const m = JSON.parse(line); // throws if a banner leaked onto stdout
    assert.equal(m.jsonrpc, "2.0", `non-JSON-RPC line on stdout: ${line}`);
  }
  assert.match(r.err, /booting/, "the human-facing banner belongs on stderr");
});

test("a bad line does not kill the server — the NEXT request is still answered", { skip: offline }, async () => {
  const r = await speak(
    [
      INIT,
      { jsonrpc: "2.0", id: 2, method: "no/such/method", params: {} },
      { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
    ],
    { site: LIVE },
  );
  const messages = r.lines.map((l) => JSON.parse(l));
  const bad = messages.find((m) => m.id === 2);
  const ping = messages.find((m) => m.id === 3);
  assert.equal(bad.error.code, -32601, "an unimplemented method is MethodNotFound");
  assert.ok(ping, "the server answered a request that FOLLOWED a bad one");
  assert.deepEqual(ping.result, {});
  assert.equal(r.code, 0, "clean exit when stdin closes");
});

test("IMPORTING the package does not boot a server — the entry-point guard", async () => {
  // `package.json` maps BOTH `bin` and the `.` export to dist/index.js, so
  // without `isEntryPoint()` an `import("datamancy")` boots a live stdio server
  // in the importer's process: it fetches the origin, writes seven lines to the
  // importer's stderr, blocks on stdin and never returns. Proven by mutating
  // `if (isEntryPoint())` to `if (true)` — the import hung until killed, and
  // ALL 27 test files stayed green, because every one of them either imports a
  // sibling module or spawns the bin (where the guard is true by definition).
  // The one caller that meets the false branch had no test at any vantage.
  //
  // Hermetic by pointing at an unreachable origin: a BROKEN guard then boots,
  // fails preflight, and exits non-zero with output — fast and offline —
  // instead of reaching datamancy.dev and hanging.
  const importer = `await import(${JSON.stringify(pathToFileURL(BIN).href)});`;
  const r = await speak([], {
    args: [],
    spawnArgs: ["--input-type=module", "-e", importer],
    site: "http://127.0.0.1:1", // refused immediately
    timeoutMs: 20_000,
  });
  assert.equal(r.code, 0, `import must settle and exit cleanly; stderr:\n${r.err}`);
  assert.equal(r.out, "", `import must write nothing to stdout: ${JSON.stringify(r.out)}`);
  assert.equal(
    r.err,
    "",
    `import must not log — a booting server announces itself:\n${r.err}`,
  );
});

test("`current` DISCLOSES an active pin before telling you what to freeze", { skip: offline }, async () => {
  // `currentVersion()` reads the live head BY DESIGN — "am I behind?" is the
  // question worth answering, and a pinned consumer already knows their own
  // hash. But `current` printed that head with no sign a pin was in force and
  // then said "Freeze this exact grimoire", handing a PINNED operator a
  // different hash and an instruction to adopt it. The command that exists to
  // confirm a posture must disclose the posture it is running under.
  //
  // The pin here is well-formed but names no snapshot, which is deliberate: it
  // proves the disclosure comes from the CONFIGURED posture and not from
  // anything the origin returned. (A pin that cannot resolve is caught at boot
  // and by `mirror`, both of which do preflight; `current` never resolves it.)
  const pin = `sha256:${"a".repeat(64)}`;
  const r = await speak([], { env: { DATAMANCY_PIN: pin }, args: ["current"], timeoutMs: 30_000 });
  assert.equal(r.code, 0);
  assert.match(r.out, /^posture: PINNED sha256:a{64}$/m, "the pin is stated verbatim");
  assert.match(r.out, /You are PINNED, so this is NOT what you are serving/);
  assert.match(
    r.out,
    /LIVE head at this origin/,
    "and the version printed is labelled as the live head, not as yours",
  );
});

test("`current` names the LIVE head as such, and the posture, against the real origin", { skip: offline }, async () => {
  const plain = await speak([], { args: ["current"], timeoutMs: 30_000 });
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^posture: LIVE/m, "an unpinned run says it is live");
  assert.match(plain.out, /LIVE head at this origin/, "and labels the version it prints");
  assert.doesNotMatch(
    plain.out,
    /You are PINNED/,
    "an unpinned run must not claim a pin",
  );
});
