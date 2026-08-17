// The mutation harness must still POINT AT REAL CODE.
//
// `scripts/verify-contract-marks.mjs` is what makes CONTRACT.md's per-rule test
// citations true rather than typed: it deletes each guard in a scratch clone and
// checks the cited test goes red. It is slow — 22 builds and 22 suite runs — so
// it is deliberately not in `npm test`, and CONTRACT.md asks the practitioner to
// re-run it "whenever a mark changes".
//
// That is a convention, and it failed the first time it was tested. Inlining a
// two-line private method in `grimoire.ts` left one rule's mutation anchor
// pointing at a string that no longer existed. The full suite stayed GREEN, the
// contract still claimed the rule was mutation-verified, and the only thing that
// knew otherwise was a script nothing runs.
//
// The expensive proof cannot move into the gate; the cheap half can. Every
// anchor is a literal that must occur in `src/` — checking that costs a handful
// of file reads, and it converts "remember to re-run the harness" from a
// convention into a red test. It does NOT prove a mark is true; it proves the
// harness can still ask the question. The `cites` half stays with the script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { RULES } from "../scripts/verify-contract-marks.mjs";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(src, f), "utf-8");

test("importing the harness does NOT run it (the guard that makes this test cheap)", () => {
  // Without the entry-point guard in the script, the import above would have
  // spent minutes running the full mutation sweep before this file's first
  // assertion. The evidence is that we got here at all — plus the table itself.
  assert.ok(Array.isArray(RULES), "RULES is exported as data, not as a side effect");
  assert.ok(RULES.length >= 20, `expected the full rule table, got ${RULES.length}`);
});

test("every mutation anchor still exists in the file it names", () => {
  const stale = [];
  for (const { rule, file, from } of RULES) {
    if (!read(file).includes(from)) stale.push(`${rule} → src/${file}`);
  }
  assert.deepEqual(
    stale,
    [],
    "these guards were renamed or reshaped, so the harness silently stops testing them",
  );
});

test("every rule names a file that exists, and a cited test that exists", () => {
  const srcFiles = new Set(readdirSync(src));
  const testDir = dirname(fileURLToPath(import.meta.url));
  const testFiles = new Set(
    readdirSync(testDir)
      .filter((f) => f.endsWith(".test.mjs"))
      .map((f) => f.replace(".test.mjs", "")),
  );
  for (const { rule, file, cites } of RULES) {
    assert.ok(srcFiles.has(file), `${rule} names src/${file}, which does not exist`);
    for (const c of cites) {
      assert.ok(testFiles.has(c), `${rule} cites test/${c}.test.mjs, which does not exist`);
    }
  }
});

// ── The harness must be measured against the CONTRACT, not against itself ────

/** Every numbered rule in CONTRACT.md's two normative lists, with the mark it
 *  carries: a set of cited test files, or `by construction`. */
function contractRules() {
  const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "CONTRACT.md"), "utf-8");
  const lines = md.split("\n");
  const rules = [];
  let prefix = null;
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n");
    current.byConstruction = /\*\*by construction\*\*/.test(body);
    current.cites = [...body.matchAll(/test\/([a-z-]+)\.test\.mjs/g)].map((m) => m[1]);
    rules.push(current);
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      prefix = /MAY change these freely/.test(line)
        ? "MAY"
        : /MUST NEVER change these/.test(line)
          ? "MN"
          : null;
      continue;
    }
    const item = /^\s{0,3}(\d+[a-z]?)\.\s+\*\*/.exec(line);
    if (prefix && item) {
      flush();
      current = { id: `${prefix} ${item[1]}`, body: [line] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return rules;
}

/** A harness entry's rule ID, normalised to CONTRACT.md's vocabulary. The table
 *  writes both "MUST NEVER 1" and "MN 7" for the same list. */
const harnessId = (rule) => rule.split(" — ")[0].trim().replace(/^MUST NEVER/, "MN");

test("the CONTRACT parse is non-vacuous — it finds both lists and their marks", () => {
  // Everything below is a claim about a set this function produced. If the
  // parse silently returned nothing, every cross-reference would pass empty.
  const rules = contractRules();
  const may = rules.filter((r) => r.id.startsWith("MAY "));
  const mn = rules.filter((r) => r.id.startsWith("MN "));
  assert.ok(may.length >= 10, `expected the full MAY list, parsed ${may.length}`);
  assert.ok(mn.length >= 11, `expected the full MUST NEVER list, parsed ${mn.length}`);
  assert.ok(
    rules.some((r) => r.byConstruction),
    "at least one rule is marked `by construction` — the parse must see that mark",
  );
  assert.ok(
    rules.every((r) => r.byConstruction || r.cites.length > 0),
    `every rule must carry SOME mark; unmarked: ${rules
      .filter((r) => !r.byConstruction && !r.cites.length)
      .map((r) => r.id)
      .join(", ")}`,
  );
});

test("EVERY test-marked contract rule has a mutation in the harness", () => {
  // The defect this closes, and it is the one this whole file exists for.
  // CONTRACT.md promised that "a rule marked with a test has been verified the
  // only way that means anything: the guard was deleted and that test went
  // red", and the harness reported "All 22 verified". CONTRACT.md carried 22
  // test-marked rules. The counts matched and the SETS DID NOT — six marked
  // rules had no harness entry at all and had never been mutated.
  //
  // A total that can only ever equal itself is not coverage. The harness is now
  // measured against the document it claims to verify.
  const rules = contractRules().filter((r) => !r.byConstruction);
  const ids = new Set(rules.map((r) => r.id));
  // Longest-prefix, so a sub-mutation ("MAY 9b") counts toward its rule
  // ("MAY 9") while a genuinely distinct rule ("MN 3a") claims its own.
  const covered = new Set();
  for (const { rule } of RULES) {
    const id = harnessId(rule);
    const match = [...ids].filter((c) => id === c || id.startsWith(`${c}`)).sort((a, b) => b.length - a.length)[0];
    if (match) covered.add(match);
  }
  const unproven = rules.map((r) => r.id).filter((id) => !covered.has(id));
  assert.deepEqual(
    unproven,
    [],
    "these rules are marked with a test in CONTRACT.md but no mutation ever removes their guard",
  );
});

test("every harness rule ID names a rule CONTRACT.md actually has", () => {
  // The mirror. An entry named "MN 3c" when the document's list runs
  // 3, 3a, 3b is unauditable: a reader cross-referencing it finds nothing.
  const ids = new Set(contractRules().map((r) => r.id));
  const orphans = RULES.map(({ rule }) => harnessId(rule))
    .filter((id) => /^(MAY|MN) \d/.test(id))
    .filter((id) => ![...ids].some((c) => id === c || id.startsWith(`${c}`)));
  assert.deepEqual(orphans, [], "harness entries naming rules that do not exist in CONTRACT.md");
});

test("a mutation must actually CHANGE the source — `from` and `to` differ", () => {
  // A rule whose replacement equals its anchor mutates nothing, builds clean,
  // and reports every cited test green — an unfalsifiable PASS.
  for (const { rule, from, to } of RULES) {
    assert.notEqual(from, to, `${rule} replaces its anchor with itself`);
  }
});
