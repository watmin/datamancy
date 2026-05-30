import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  ManifestShapeError,
  ManifestFetchError,
} from "../dist/manifest.js";

const H = "a".repeat(64);
const good = {
  schemaVersion: 1,
  serverInfo: { name: "datamancy.dev", version: "abc1234" },
  epoch: 1780000000,
  previous: null,
  trust: { algorithm: "SHA-256", tier: 2, signed: true },
  resources: [
    {
      name: "cernere",
      uri: "cernere/SKILL.md",
      blob: `blobs/sha256/${H}`,
      mimeType: "text/markdown",
      sha256: H,
      size: 100,
    },
  ],
};
const bytes = (o) => Buffer.from(JSON.stringify(o));

test("parses a valid schemaVersion-1 manifest", () => {
  const m = parseManifest(bytes(good), "u");
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.resources[0].blob, `blobs/sha256/${H}`);
});

test("REQUIRES schemaVersion, previous, and epoch — no silent-assumption bypass", () => {
  for (const field of ["schemaVersion", "previous", "epoch"]) {
    const bad = structuredClone(good);
    delete bad[field];
    assert.throws(
      () => parseManifest(bytes(bad), "u"),
      ManifestShapeError,
      `missing ${field} must be rejected`,
    );
  }
});

test("REQUIRES every resource to carry its immutable blob", () => {
  const bad = structuredClone(good);
  delete bad.resources[0].blob;
  assert.throws(() => parseManifest(bytes(bad), "u"), ManifestShapeError);
});

test("previous may be null (genesis) but must be present", () => {
  const genesis = structuredClone(good); // previous: null
  assert.doesNotThrow(() => parseManifest(bytes(genesis), "u"));
});

test("rejects a resource with a non-hex sha256", () => {
  const bad = structuredClone(good);
  bad.resources[0].sha256 = "not-a-hash";
  assert.throws(() => parseManifest(bytes(bad), "u"), ManifestShapeError);
});

test("rejects a manifest missing trust", () => {
  const bad = structuredClone(good);
  delete bad.trust;
  assert.throws(() => parseManifest(bytes(bad), "u"), ManifestShapeError);
});

test("rejects a wrong-typed schemaVersion", () => {
  const bad = structuredClone(good);
  bad.schemaVersion = "1";
  assert.throws(() => parseManifest(bytes(bad), "u"), ManifestShapeError);
});

test("rejects invalid JSON as a shape (verification) failure, not transport", () => {
  // Bytes that passed signature verification but aren't valid JSON are a
  // corrupt trust root — a verification-class failure.
  assert.throws(
    () => parseManifest(Buffer.from("{not json"), "u"),
    ManifestShapeError,
  );
});
