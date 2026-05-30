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

test("tolerates an old manifest without the new optional fields", () => {
  const old = {
    serverInfo: { name: "x", version: "y" },
    trust: { algorithm: "SHA-256", tier: 2, signed: true },
    resources: [
      {
        name: "a",
        uri: "a/SKILL.md",
        mimeType: "text/markdown",
        sha256: "b".repeat(64),
        size: 1,
      },
    ],
  };
  assert.doesNotThrow(() => parseManifest(bytes(old), "u"));
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

test("rejects invalid JSON", () => {
  assert.throws(
    () => parseManifest(Buffer.from("{not json"), "u"),
    ManifestFetchError,
  );
});
