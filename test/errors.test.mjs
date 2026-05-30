// The severity classification IS the loud-vs-quiet gate (serve-quiet on
// transport, scream on a tamper). Prove it's structural, not convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DatamancyError,
  isVerificationFailure,
  UnknownResourceError,
  BadPinError,
  VersionNotFoundError,
  BadParamsError,
  PinMismatchError,
} from "../dist/errors.js";
import { ManifestFetchError, ManifestShapeError } from "../dist/manifest.js";
import { SignatureFetchError, SignatureInvalidError } from "../dist/signature.js";
import {
  ResourceFetchError,
  HashMismatchError,
  SizeMismatchError,
} from "../dist/resources.js";

const r = { name: "x", uri: "u", mimeType: "text/markdown", sha256: "a".repeat(64), size: 1 };

// "Got bytes and they're wrong" — must be LOUD.
const verification = [
  new SignatureInvalidError("m", "s"),
  new ManifestShapeError("m"),
  new HashMismatchError(r, "a", "b"),
  new SizeMismatchError(r, 1, 2),
  new PinMismatchError("a", "b", "u"),
];
// "Couldn't get the bytes" — serve last-known-good quietly.
const transport = [
  new ManifestFetchError("u"),
  new SignatureFetchError("u"),
  new ResourceFetchError(r),
];
// Caller/request errors — propagate.
const config = [
  new UnknownResourceError("u"),
  new BadPinError("nothex"),
  new VersionNotFoundError("v", "s"),
  new BadParamsError("bad"),
];

test("every trust-path error extends DatamancyError with a declared severity", () => {
  for (const e of [...verification, ...transport, ...config]) {
    assert.ok(e instanceof DatamancyError, `${e.name} extends DatamancyError`);
    assert.ok(
      ["verification", "transport", "config"].includes(e.severity),
      `${e.name} declares a severity`,
    );
    // Identity is set by construction, not hand-copied.
    assert.equal(e.name, e.constructor.name, `${e.name} name == class name`);
  }
});

test("isVerificationFailure is true for EXACTLY the verification-severity errors", () => {
  for (const e of verification) {
    assert.equal(isVerificationFailure(e), true, `${e.name} is loud`);
  }
  for (const e of [...transport, ...config]) {
    assert.equal(isVerificationFailure(e), false, `${e.name} is not loud`);
  }
});

test("an unclassified (non-DatamancyError) throw is not treated as verification", () => {
  assert.equal(isVerificationFailure(new Error("mystery")), false);
  assert.equal(isVerificationFailure(null), false);
  assert.equal(isVerificationFailure("string"), false);
});
