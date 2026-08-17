#!/usr/bin/env node
// Verify that CONTRACT.md's per-rule test citations are TRUE.
//
// The contract claims each rule is "marked with the test that fails if the rule
// is broken", and that a marked rule "has been verified the only way that means
// anything: the guard was deleted and the suite went red."
//
// That claim was false when first written. Six of twenty-one marks cited files
// that stayed green when the guard was removed — including the no-redirect rule,
// whose only real enforcer (ssrf) the contract never named. An auditor following
// the contract's own instructions would have deleted the SSRF guard, run the two
// cited files, seen green, and concluded the rule held.
//
// So the citations are no longer asserted. This script mutates each guard in a
// scratch copy, records which test FILES go red, and fails if a cited file is
// not among them. Run it whenever CONTRACT.md's marks change:
//
//     node scripts/verify-contract-marks.mjs
//
// It is slow (one full build + N test runs per mutation) and deliberately not
// part of `npm test` — it exists so the marks can be re-earned, not re-typed.
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, readdirSync, realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Each entry: the contract rule, the guard that enforces it, and the mutation
 *  that removes it. `cites` is what CONTRACT.md claims — the thing under test. */
export const RULES = [
  { rule: "MUST NEVER 1 — trust.algorithm frozen", file: "manifest.ts",
    from: 't.algorithm !== "SHA-256"', to: "false",
    cites: ["contract", "forward-compat"] },
  { rule: "MUST NEVER 2 — required shapes frozen", file: "manifest.ts",
    from: 'typeof t.tier !== "number"', to: "false", cites: ["contract"] },
  { rule: "MUST NEVER 3 — resource fields", file: "manifest.ts",
    from: 'typeof r.mimeType === "string" &&', to: "", cites: ["contract"] },
  { rule: "MUST NEVER 3a — declared chain/format fields", file: "manifest.ts",
    from: "!Number.isInteger(m.schemaVersion) ||", to: "", cites: ["forward-compat"] },
  { rule: "MUST NEVER 5 — UTF-8 bodies", file: "resources.ts",
    from: "fatal: true", to: "fatal: false", cites: ["http"] },
  { rule: "MUST NEVER 5a — 16 MiB ceiling", file: "manifest.ts",
    from: "r.size <= MAX_RESOURCE_BYTES", to: "true", cites: ["contract", "forward-compat"] },
  { rule: "MUST NEVER 6 — frozen paths", file: "grimoire.ts",
    from: "/.well-known/mcp/manifest.json", to: "/.well-known/mcp2/manifest.json",
    cites: ["contract"] },
  { rule: "MUST NEVER 8 — no 3xx redirects", file: "manifest.ts",
    from: 'redirect: "error"', to: 'redirect: "follow"', cites: ["ssrf"] },
  { rule: "MUST NEVER 9 — origin-relative uri/blob", file: "manifest.ts",
    from: 'new URL(path, "https://origin.invalid/").origin ===\n      "https://origin.invalid"',
    to: 'Boolean(new URL(path, "https://origin.invalid/"))', cites: ["contract"] },
  { rule: "MUST NEVER 10 — unique resource names", file: "manifest.ts",
    from: "if (names.size !== m.resources.length) return false;", to: "", cites: ["contract"] },
  // The MAY list's TOLERANCE rules invert the usual shape. There is no guard to
  // delete — the tolerance IS the absence of a check — so the mutation INJECTS
  // the strictness the rule forbids and requires the suite to notice. Same
  // question either way: does a test go red when the rule stops holding?
  { rule: "MAY 1 — a content edit propagates on the next read", file: "grimoire.ts",
    from: "      const fetched = await fetchAndVerify(resource, signal, fetchUrl);",
    to: "      const memoed = this.contentMemo.get(key);\n      if (memoed) return { fetched: memoed.fetched, provenance: \"verified\" };\n      const fetched = await fetchAndVerify(resource, signal, fetchUrl);",
    cites: ["grimoire-trust", "tools"] },
  { rule: "MAY 3 — unknown top-level manifest fields tolerated", file: "manifest.ts",
    from: '  if (typeof m.serverInfo !== "object" || m.serverInfo === null) return false;',
    to: '  if (Object.keys(m).some((k) => !["schemaVersion", "serverInfo", "previous", "epoch", "trust", "resources"].includes(k))) return false;\n  if (typeof m.serverInfo !== "object" || m.serverInfo === null) return false;',
    cites: ["forward-compat"] },
  { rule: "MAY 4 — unknown serverInfo fields tolerated", file: "manifest.ts",
    from: '  if (typeof si.name !== "string" || typeof si.version !== "string") return false;',
    to: '  if (Object.keys(si).some((k) => !["name", "version"].includes(k))) return false;\n  if (typeof si.name !== "string" || typeof si.version !== "string") return false;',
    cites: ["forward-compat"] },
  { rule: "MAY 6 — unknown resource fields tolerated", file: "manifest.ts",
    from: "    typeof r.name === \"string\" &&",
    to: "    Object.keys(r).every((k) => [\"name\", \"description\", \"uri\", \"blob\", \"mimeType\", \"sha256\", \"size\"].includes(k)) &&\n    typeof r.name === \"string\" &&",
    cites: ["forward-compat"] },
  { rule: "MAY 7 — lookup is by name/uri, never by position", file: "grimoire.ts",
    from: "const resource = manifest.resources.find(select);",
    to: "const resource = manifest.resources[0];",
    cites: ["contract"] },
  { rule: "MAY 10 — self-hosting resolves against DATAMANCY_SITE", file: "grimoire.ts",
    from: "return new URL(pathOrUrl, `${this.site}/`).toString();",
    to: 'return new URL(pathOrUrl, "https://datamancy.dev/").toString();',
    cites: ["contract", "resilience"] },
  { rule: "MAY 2 — a spell-set change nudges", file: "grimoire.ts",
    from: "return Grimoire.spellSetDiffFrom(prevKey, key, manifest);", to: "return null;",
    cites: ["listchange", "tools"] },
  { rule: "MAY 9b — versions lists 50", file: "grimoire.ts",
    from: "async listVersions(limit = 50)", to: "async listVersions(limit = 40)",
    cites: ["contract"] },
  { rule: "MAY 9c — a label resolves within 100", file: "grimoire.ts",
    from: "const MAX_VERSION_WALK = 100;", to: "const MAX_VERSION_WALK = 50;",
    cites: ["contract"] },
  { rule: "MN 7 — previous is shape-gated", file: "manifest.ts",
    from: "!/^sha256:[0-9a-f]{64}$/.test(m.previous))", to: "false)",
    cites: ["forward-compat"] },
  { rule: "MN 11 — the tool wire shape is frozen", file: "mcp.ts",
    from: 'name: "fetch_spell"', to: 'name: "get_spell"', cites: ["tools", "process"] },
  { rule: "break signal — a future schemaVersion is refused", file: "manifest.ts",
    from: "data.schemaVersion > KERNEL_SCHEMA_MAJOR", to: "data.schemaVersion < 0",
    cites: ["forward-compat"] },
  { rule: "MAY 9d — a listing truncates, a tamper does not", file: "grimoire.ts",
    from: "if (isVerificationFailure(err) || out.length === 0) throw err;",
    to: "if (false) throw err;", cites: ["chain"] },
  { rule: "Concurrency — manifest loads coalesce", file: "grimoire.ts",
    from: "this.manifestInFlight = load;", to: "",
    cites: ["concurrency"] },
  { rule: "Concurrency — the coalescer is not a cache", file: "grimoire.ts",
    from: "      this.manifestInFlight = null;", to: "",
    cites: ["concurrency"] },
  { rule: "MN 3a — a non-finite epoch is refused", file: "manifest.ts",
    from: "!Number.isFinite(m.epoch) ||", to: "",
    cites: ["forward-compat"] },
  { rule: "MN 3b — equal epoch accepted", file: "grimoire.ts",
    from: "if (ep < this.highestEpoch) {", to: "if (ep <= this.highestEpoch) {",
    cites: ["rollback"] },
  { rule: "Timeouts — every fetch bounded", file: "resources.ts",
    from: 'res = await fetch(url, { signal, redirect: "error" });',
    to: 'res = await fetch(url, { redirect: "error" });', cites: ["timeout"] },
  { rule: "Timeouts — one deadline for the whole walk", file: "grimoire.ts",
    from: "const hop = await this.fetchOne(url, expect, signal);",
    to: "const hop = await this.fetchOne(url, expect, undefined);", cites: ["timeout"] },
  { rule: "Timeouts — the override is clamped", file: "grimoire.ts",
    from: "Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)",
    to: "requested", cites: ["timeout"] },
  { rule: "Timeouts — warm is the tighter bound", file: "grimoire.ts",
    from: "haveMemo ? this.warmTimeoutMs : this.coldTimeoutMs,",
    to: "this.coldTimeoutMs,", cites: ["timeout"] },
  { rule: "MAY 5 — signature always verified", file: "grimoire.ts",
    from: "verifyManifestSignature(bytes, sig, url, sigUrl, this.verifyKey);",
    to: 'if (JSON.parse(Buffer.from(bytes).toString("utf-8"))?.trust?.signed !== false) verifyManifestSignature(bytes, sig, url, sigUrl, this.verifyKey);',
    cites: ["contract"] },
];

/**
 * The expensive proof runs ONLY when this file is the process entry point.
 *
 * `test/contract-marks.test.mjs` imports `RULES` to check, in milliseconds,
 * that every mutation anchor still exists in `src/` — the cheap half of what
 * this script does. Without this guard that import would run 22 builds.
 */
const isEntryPoint =
  Boolean(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "datamancy-marks-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
for (const d of ["src", "test", "scripts"]) cpSync(join(repo, d), join(work, d), { recursive: true });
// The root DOCS are part of the clone, not decoration. Three test files read
// them — `contract-marks` parses CONTRACT.md, `pinned-key` reads the fingerprint
// out of README.md, `packaging` checks the shipped doc set — so a clone without
// them made all three fail for EVERY mutation, unconditionally. That poisons the
// evidence twice: it pads every rule's red list with files the mutation never
// touched, and it means `red` is never empty, silently killing the "NOTHING went
// red" arm below — this harness's only detector for a rule enforced by nothing.
for (const f of [
  "package.json",
  "tsconfig.json",
  "README.md",
  "CONTRACT.md",
  "RECOVERY.md",
]) {
  cpSync(join(repo, f), join(work, f));
}
cpSync(join(repo, "node_modules"), join(work, "node_modules"), { recursive: true });

const pristine = Object.fromEntries(
  readdirSync(join(work, "src")).map((f) => [f, readFileSync(join(work, "src", f), "utf-8")]),
);
const testFiles = readdirSync(join(work, "test")).filter((f) => f.endsWith(".test.mjs"));
const restore = () => {
  for (const [f, text] of Object.entries(pristine)) writeFileSync(join(work, "src", f), text);
};

/**
 * Run one test file in the clone and say whether it went red — BOUNDED.
 *
 * Every run here carries a hard timeout, because a mutation is allowed to make
 * the code hang and one of them does: removing the entry-point guard in
 * index.ts makes importing the module boot a stdio server that blocks on stdin
 * forever, and `test/errors.test.mjs` imports every file in dist/ to enumerate
 * the error classes. Unbounded, that deadlocked the whole harness — it sat at
 * rule 24 of 33 for half an hour at zero CPU, looking exactly like slow
 * progress. The thing being measured is "does removing this guard break
 * something", and a hang IS broken; it must be recorded, not waited on.
 *
 * SIGKILL rather than the default SIGTERM: the wedged process is blocked on
 * stdin inside a server this suite deliberately broke, and it does not deserve
 * a chance to ignore the signal.
 *
 * The slowest legitimate file takes ~4s (the whole 28-file suite takes ~5s), so
 * 90s is ~20x headroom — generous enough never to fire on a slow box, short
 * enough that a genuine hang is a finding within seconds instead of never.
 */
const TEST_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 180_000;

function runTest(work, file) {
  const r = spawnSync(process.execPath, ["--test", `test/${file}`], {
    cwd: work,
    timeout: TEST_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // A timeout is a red, and a DISTINCT one: "hung" and "asserted false" are
  // different facts about the mutation, and the caster needs to tell them apart.
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  return { red: timedOut || r.status !== 0, timedOut };
}

function build(work) {
  return spawnSync("npx", ["tsc"], {
    cwd: work,
    encoding: "utf-8",
    timeout: BUILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

// BASELINE: the unmutated clone must be fully green before any mutation result
// means anything. Every verdict below is "these files went red BECAUSE of the
// mutation" — a claim that is only true if they were green without it.
//
// This is not hypothetical. The clone once omitted the root docs, so three test
// files failed on every rule regardless of what was mutated: their names padded
// each red list, and `red` was never empty, which silently disabled the
// "NOTHING went red" detector. The results still LOOKED like 31 clean passes.
// A baseline turns that from invisible into the first thing that fails.
{
  const built = build(work);
  if (built.status !== 0) {
    console.error(`BASELINE BUILD FAILED — the clone is not faithful:\n${built.stderr}`);
    process.exit(1);
  }
  const red = testFiles.filter((t) => runTest(work, t).red);
  if (red.length > 0) {
    console.error(
      `BASELINE NOT GREEN — ${red.join(", ")} fail in the UNMUTATED clone.\n` +
        `Every result below would be measured against a broken baseline, so no\n` +
        `mutation verdict can be trusted. Usually the clone is missing a file\n` +
        `those tests read; see the cpSync list above.`,
    );
    process.exit(1);
  }
  console.log(`baseline: ${testFiles.length} test files green in the clone\n`);
}

let failures = 0;
for (const { rule, file, from, to, cites } of RULES) {
  restore();
  const path = join(work, "src", file);
  const text = readFileSync(path, "utf-8");
  if (!text.includes(from)) {
    console.log(`✗ ${rule}\n    the guard's anchor no longer exists in src/${file} — the mutation is stale`);
    failures++;
    continue;
  }
  writeFileSync(path, text.replace(from, to));
  const built = build(work);
  if (built.status !== 0) {
    console.log(`✗ ${rule}\n    removing the guard does not compile; mutation needs rewriting`);
    failures++;
    continue;
  }
  // `contract-marks` is excluded by construction, not by taste. It asserts that
  // every anchor in THIS table still occurs in src/ — so mutating an anchor is
  // precisely what makes it red, for every rule, unconditionally. Counting it
  // would leave `red` never empty and silently kill the "NOTHING went red"
  // arm below, which is this harness's only detector for a rule enforced by
  // nothing at all. A meta-test about the instrument is not evidence about the
  // rule the instrument is measuring.
  const META = new Set(["contract-marks"]);
  const hung = [];
  const red = testFiles
    .filter((t) => {
      const { red: isRed, timedOut } = runTest(work, t);
      if (timedOut) hung.push(t.replace(".test.mjs", ""));
      return isRed;
    })
    .map((t) => t.replace(".test.mjs", ""))
    .filter((t) => !META.has(t));

  const uncovered = cites.filter((c) => !red.includes(c));
  if (red.length === 0) {
    console.log(`✗ ${rule}\n    NOTHING went red — the rule is not enforced at all`);
    failures++;
  } else if (uncovered.length > 0) {
    console.log(`✗ ${rule}\n    cites ${uncovered.join(", ")} which stayed GREEN; actually red: ${red.join(", ")}`);
    failures++;
  } else {
    const note = hung.length ? `; HUNG (killed at ${TEST_TIMEOUT_MS / 1000}s): ${hung.join(", ")}` : "";
    console.log(`✓ ${rule}  (red: ${red.join(", ")}${note})`);
  }
}
restore();
if (failures === 0) {
  console.log(`\nAll ${RULES.length} verified: every cited test goes red when its guard is removed.`);
} else {
  // stderr, so a `| tail` that swallows the exit code still shows the failure.
  console.error(`\n${failures} of ${RULES.length} marks are FALSE.`);
}
process.exit(failures === 0 ? 0 : 1);
}
