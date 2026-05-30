// Hermetic crypto tests — a throwaway P-256 keypair, signed exactly the way
// KMS signs (ECDSA over SHA-256, DER), verified through our own code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  verifyManifestSignature,
  SignatureInvalidError,
} from "../dist/signature.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const data = Buffer.from("the exact manifest bytes KMS signs a digest of");
const sig = sign("sha256", data, { key: privateKey, dsaEncoding: "der" });

test("accepts a valid ECDSA P-256 / SHA-256 / DER signature", () => {
  assert.doesNotThrow(() =>
    verifyManifestSignature(data, sig, "m", "s", publicKey),
  );
});

test("rejects when the manifest bytes are tampered", () => {
  const tampered = Buffer.from("the exact manifest bytes KMS signs — NOPE");
  assert.throws(
    () => verifyManifestSignature(tampered, sig, "m", "s", publicKey),
    SignatureInvalidError,
  );
});

test("rejects a signature made by a different key", () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherSig = sign("sha256", data, {
    key: other.privateKey,
    dsaEncoding: "der",
  });
  assert.throws(
    () => verifyManifestSignature(data, otherSig, "m", "s", publicKey),
    SignatureInvalidError,
  );
});
