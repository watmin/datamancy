// The error hierarchy's two axes ARE the behaviour gates: `severity` decides
// loud-vs-quiet on a fallback, `audience` decides whether a failure reaches the
// model as readable output or the host as a wire fault. Prove both are
// structural, not convention.
//
// The roster is DERIVED, never hand-listed. A hand-written list of error
// classes is a gate over a hand-list: it went stale the moment two variants
// were added, and its "every trust-path error" claim then covered 12 of 17
// while staying green. Enumerating the modules' exports means a new class is
// enrolled by existing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatamancyError, isVerificationFailure, isModelAudience } from "../dist/errors.js";

const DIST = new URL("../dist/", import.meta.url);

/** Every exported class in the SHIPPED build whose prototype chain reaches
 *  DatamancyError.
 *
 *  The module list comes from the filesystem, not from a set of `import * as`
 *  lines. An earlier version of this file derived the classes correctly but
 *  derived them *within* a hand-written map of four modules — so a subclass in
 *  a fifth module was invisible and the test stayed green while its own title
 *  claimed nothing was hand-listed. The gate's INPUTS were the hand-list. */
async function everyErrorClass() {
  const found = [];
  const files = readdirSync(fileURLToPath(DIST))
    .filter((f) => f.endsWith(".js"))
    .sort();
  for (const file of files) {
    const ns = await import(new URL(file, DIST).href);
    for (const [name, value] of Object.entries(ns)) {
      if (typeof value !== "function" || value === DatamancyError) continue;
      if (Object.prototype.isPrototypeOf.call(DatamancyError, value)) {
        found.push({ module: file, name, Class: value });
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Construct one, arity-agnostically. Constructors only interpolate their args
 *  into a message, so generic values suffice; a constructor that rejects them
 *  is itself worth surfacing, so this throws rather than skipping. */
function construct(Class) {
  return new Class("x", ["alpha", "beta"], "y", 1);
}

const CLASSES = await everyErrorClass();

test("the derived roster finds every error class on disk — nothing hand-listed", () => {
  // No floor: `>= 15` could not see a deletion from 17 down to 15, and a
  // comment denying it was a magic number while 15 sat in the assertion. The
  // honest check is that enrolment requires only existing on disk.
  const names = CLASSES.map((c) => c.name);
  assert.ok(
    CLASSES.length > 0,
    "no DatamancyError subclasses found — the enumeration itself is broken",
  );
  assert.equal(new Set(names).size, names.length, "no duplicate class names");
  // The two 1.1.0 additions must be present — the pair the old hand-list missed.
  for (const required of ["UnknownSpellError", "UnknownToolError"]) {
    assert.ok(names.includes(required), `${required} enrolled by derivation`);
  }
});

test("EVERY error class declares both axes, and its identity, by construction", () => {
  for (const { module, name, Class } of CLASSES) {
    const e = construct(Class);
    assert.ok(e instanceof DatamancyError, `${name} extends DatamancyError`);
    assert.ok(
      ["verification", "transport", "config", "internal"].includes(e.severity),
      `${module}: ${name} declares a severity (got ${JSON.stringify(e.severity)})`,
    );
    assert.ok(
      ["model", "operator"].includes(e.audience),
      `${module}: ${name} declares an audience (got ${JSON.stringify(e.audience)})`,
    );
    // Identity is set by construction, not hand-copied per subclass.
    assert.equal(e.name, e.constructor.name, `${name} name == class name`);
    assert.ok(e.message.length > 0, `${name} carries a message`);
  }
});

test("isVerificationFailure is true for EXACTLY the verification-severity classes", () => {
  for (const { name, Class } of CLASSES) {
    const e = construct(Class);
    assert.equal(
      isVerificationFailure(e),
      e.severity === "verification",
      `${name} loud iff verification-severity`,
    );
  }
});

test("isModelAudience is true for EXACTLY the model-audience classes", () => {
  for (const { name, Class } of CLASSES) {
    const e = construct(Class);
    assert.equal(
      isModelAudience(e),
      e.audience === "model",
      `${name} model-facing iff audience === "model"`,
    );
  }
});

test("an INTERNAL fault is never reported as the caller's bad parameters", () => {
  // Telling a client its params were invalid when it sent none is a lie about
  // whose fault it is. `internal` exists so our own broken ordering invariant
  // cannot borrow the caller's error code.
  const internal = CLASSES.filter((c) => construct(c.Class).severity === "internal");
  assert.ok(internal.length > 0, "the internal severity has at least one member");
  for (const { name, Class } of internal) {
    assert.equal(construct(Class).rpcCode, -32603, `${name} is not -32602`);
  }
});

test("the wire code is DERIVED from severity — a config fault is never -32603", () => {
  for (const { name, Class } of CLASSES) {
    const e = construct(Class);
    const expected = e.severity === "config" ? -32602 : -32603;
    assert.equal(e.rpcCode, expected, `${name} (${e.severity}) → ${expected}`);
  }
});

test("only ONE class is model-facing — a body an agent reads must be a deliberate choice", () => {
  // If this count moves, someone widened what reaches an LLM as readable
  // output. That should be a decision, not a diff nobody noticed.
  const modelFacing = CLASSES.filter((c) => construct(c.Class).audience === "model");
  assert.deepEqual(modelFacing.map((c) => c.name), ["UnknownSpellError"]);
});

test("an unclassified (non-DatamancyError) throw is neither loud nor model-facing", () => {
  for (const stray of [new Error("mystery"), null, "string", undefined, 42]) {
    assert.equal(isVerificationFailure(stray), false);
    assert.equal(isModelAudience(stray), false);
  }
});
