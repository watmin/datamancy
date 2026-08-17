// The immutability axis: a FROZEN kernel must tolerate the website's ADDITIVE
// future evolution (unknown fields) yet REFUSE a breaking future format
// (schemaVersion newer than it understands) LOUD instead of misreading it.
// These tests ARE the forward-compat contract, executable.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  ManifestSchemaError,
  ManifestShapeError,
  KERNEL_SCHEMA_MAJOR,
} from "../dist/manifest.js";
import { MAX_RESOURCE_BYTES } from "../dist/http.js";
import { bytesOf, manifestFor, resourceFor } from "./helpers.mjs";

const URL_ = "https://datamancy.dev/.well-known/mcp/manifest.json";
const parse = (m) => parseManifest(bytesOf(m), URL_);

// ── MAY change freely: additive fields are tolerated and round-trip ──

test("tolerates unknown TOP-LEVEL manifest fields", () => {
  const m = parse(manifestFor([resourceFor("a", "x")], { categories: ["z"] }));
  assert.equal(m.resources.length, 1);
});

test("tolerates unknown serverInfo / trust fields", () => {
  const m = parse(
    manifestFor([resourceFor("a", "x")], {
      serverInfo: { name: "t", version: "v", homepage: "https://x" },
      trust: { algorithm: "SHA-256", tier: 2, signed: true, custodian: "kms" },
    }),
  );
  assert.equal(m.serverInfo.name, "t");
});

test("tolerates unknown per-resource fields", () => {
  const r = resourceFor("a", "x", { tags: ["t"], deprecated: false });
  const m = parse(manifestFor([r]));
  assert.equal(m.resources[0].name, "a");
});

test("a schemaVersion EQUAL to the kernel major is accepted", () => {
  const m = parse(manifestFor([resourceFor("a", "x")], { schemaVersion: KERNEL_SCHEMA_MAJOR }));
  assert.equal(m.schemaVersion, KERNEL_SCHEMA_MAJOR);
});

test("a DEGENERATE schemaVersion (null / 0 / negative / fractional) is refused at the shape gate", () => {
  // The break-signal must never silently misread. JSON can't carry NaN/Infinity
  // (they serialize to null), but 0 and negatives ARE wire-representable and a
  // bare `typeof number` check let them slip BOTH this gate and `> 1` (since
  // 0 > 1 and -1 > 1 are false). Each must be a ManifestShapeError, never a
  // silent accept and never a misclassified ManifestSchemaError.
  for (const bad of [null, 0, -1, -5, 1.5, 2.5]) {
    assert.throws(
      () => parse(manifestFor([resourceFor("a", "x")], { schemaVersion: bad })),
      ManifestShapeError,
      `schemaVersion=${bad} must be refused at the shape gate`,
    );
  }
});

test("an absent schemaVersion is REJECTED — the format major must be declared", () => {
  const m = manifestFor([resourceFor("a", "x")]);
  delete m.schemaVersion;
  assert.throws(() => parse(m), ManifestShapeError);
});

test("zero resources is a valid (empty) grimoire", () => {
  assert.equal(parse(manifestFor([])).resources.length, 0);
});

test("a numeric epoch is accepted (the rollback freshness stamp)", () => {
  const m = parse(manifestFor([resourceFor("a", "x")], { epoch: 1780000000 }));
  assert.equal(m.epoch, 1780000000);
});

test("an absent epoch is REJECTED — the rollback gate must never be bypassable", () => {
  const m = manifestFor([resourceFor("a", "x")]);
  delete m.epoch;
  assert.throws(() => parse(m), ManifestShapeError);
});

test("a non-numeric / non-finite epoch is refused as corrupt shape", () => {
  assert.throws(
    () => parse(manifestFor([resourceFor("a", "x")], { epoch: "soon" })),
    ManifestShapeError,
  );

  // The non-finite case must be spliced in as RAW JSON, not passed as the JS
  // value `Infinity`. `bytesOf` is `JSON.stringify`, which renders every
  // non-finite number as `null` — so `{ epoch: Infinity }` never reached the
  // finiteness guard at all; it was caught by the `typeof !== "number"` arm and
  // the guard it names had no coverage. Deleting `!Number.isFinite(m.epoch)`
  // left the whole suite green.
  //
  // `1e999` is the reachable form: JSON has no `Infinity` literal, but an
  // over-range exponent parses to one. It is load-bearing rather than
  // defensive — an accepted `epoch: Infinity` pins `highestEpoch` permanently,
  // and every later legitimate manifest is then refused as a rollback forever.
  const raw = JSON.stringify(manifestFor([resourceFor("a", "x")], { epoch: 1 }))
    .replace('"epoch":1', '"epoch":1e999');
  assert.equal(JSON.parse(raw).epoch, Infinity, "the fixture really carries a non-finite epoch");
  assert.throws(() => parseManifest(Buffer.from(raw), URL_), ManifestShapeError);
});

// ── MUST NOT change without a new major: breaking shapes refuse LOUD ──

test("a schemaVersion NEWER than the kernel is refused LOUD (ManifestSchemaError)", () => {
  const err = (() => {
    try {
      parse(manifestFor([resourceFor("a", "x")], { schemaVersion: KERNEL_SCHEMA_MAJOR + 1 }));
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof ManifestSchemaError, `got ${err?.constructor.name}`);
  assert.equal(err.severity, "verification"); // serve last-known-good + LOUD
  assert.equal(err.declared, KERNEL_SCHEMA_MAJOR + 1);
});

test("a far-future schemaVersion (99) is refused, not guessed at", () => {
  assert.throws(
    () => parse(manifestFor([resourceFor("a", "x")], { schemaVersion: 99 })),
    ManifestSchemaError,
  );
});

test("dropping a required resource field (sha256→digest) is refused as corrupt", () => {
  const r = resourceFor("a", "x");
  delete r.sha256;
  r.digest = "deadbeef";
  assert.throws(() => parse(manifestFor([r])), ManifestShapeError);
});

test("an uppercase / non-hex sha256 is refused (case + charset frozen)", () => {
  const r = resourceFor("a", "x");
  r.sha256 = r.sha256.toUpperCase();
  assert.throws(() => parse(manifestFor([r])), ManifestShapeError);
});

test("a resource declaring a size past the memory ceiling is refused", () => {
  const r = resourceFor("a", "x");
  r.size = MAX_RESOURCE_BYTES + 1; // (sha256 won't match, but size is checked at shape time)
  assert.throws(() => parse(manifestFor([r])), ManifestShapeError);
});

test("a resource at exactly the memory ceiling is structurally accepted", () => {
  const r = resourceFor("a", "x");
  r.size = MAX_RESOURCE_BYTES;
  // Shape is valid; only the (separate) hash/size fetch check would later run.
  assert.equal(parse(manifestFor([r])).resources[0].size, MAX_RESOURCE_BYTES);
});

test("a `previous` that isn't sha256:<hex64> is refused (no fetch-URL injection)", () => {
  for (const bad of [
    "../../evil",
    "https://evil.example/x",
    "sha256:NOTHEX",
    "deadbeef",
    "sha256:" + "a".repeat(63), // one short
  ]) {
    assert.throws(
      () => parse(manifestFor([resourceFor("a", "x")], { previous: bad })),
      ManifestShapeError,
      `previous=${bad} must be refused`,
    );
  }
});

test("a valid sha256:<hex64> previous (or null genesis) is accepted", () => {
  const h = "sha256:" + "a".repeat(64);
  assert.equal(parse(manifestFor([resourceFor("a", "x")], { previous: h })).previous, h);
  assert.equal(parse(manifestFor([resourceFor("a", "x")], { previous: null })).previous, null);
});

test("changing trust.algorithm off SHA-256 is refused (crypto-agility = new major)", () => {
  assert.throws(
    () =>
      parse(
        manifestFor([resourceFor("a", "x")], {
          trust: { algorithm: "SHA-512", tier: 2, signed: true },
        }),
      ),
    ManifestShapeError,
  );
});
