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

test("an absent schemaVersion is accepted (treated as the base format)", () => {
  const m = manifestFor([resourceFor("a", "x")]);
  delete m.schemaVersion;
  assert.equal(parse(m).resources.length, 1);
});

test("zero resources is a valid (empty) grimoire", () => {
  assert.equal(parse(manifestFor([])).resources.length, 0);
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
