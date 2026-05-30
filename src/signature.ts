/**
 * ECDSA P-256 signature verification for the datamancy.dev manifest.
 *
 * The manifest at datamancy.dev/.well-known/mcp/manifest.json is signed by
 * a key held in AWS KMS (non-exportable; signing happens inside the HSM).
 * The detached DER signature lives at manifest.json.sig. This module fetches
 * it and verifies it against the pinned public key.
 *
 * Verification flow:
 *   1. Fetch the raw manifest bytes (not parsed JSON yet — we verify the
 *      exact bytes the server returned, before any transformation)
 *   2. Fetch the raw signature bytes (DER-encoded ECDSA)
 *   3. verify("sha256", manifestBytes, {key, dsaEncoding:"der"}, sig) —
 *      node hashes the bytes with SHA-256 and verifies the P-256 signature,
 *      reproducing the digest KMS signed under ECDSA_SHA_256
 *   4. Pass → proceed to JSON parse + use
 *   5. Fail → reject; signal MUST NOT reach the LLM
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { PINNED_PUBKEY_PEM } from "./pinned-pubkey.js";

const PUBKEY: KeyObject = createPublicKey({
  key: PINNED_PUBKEY_PEM,
  format: "pem",
});

export class SignatureFetchError extends Error {
  constructor(public url: string, public cause?: unknown) {
    super(`Failed to fetch signature from ${url}: ${cause}`);
    this.name = "SignatureFetchError";
  }
}

export class SignatureInvalidError extends Error {
  constructor(public manifestUrl: string, public signatureUrl: string) {
    super(
      `Signature verification FAILED. ` +
        `Manifest: ${manifestUrl}. Signature: ${signatureUrl}. ` +
        `The signature does not match the manifest content under the pinned ` +
        `public key. Manifest REJECTED — no content will be loaded.`,
    );
    this.name = "SignatureInvalidError";
  }
}

export async function fetchSignature(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (cause) {
    throw new SignatureFetchError(url, cause);
  }
  if (!res.ok) {
    throw new SignatureFetchError(url, `HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Verify a manifest's signature against the pinned public key.
 * Throws SignatureInvalidError on mismatch. No other return value —
 * either we proceed (verification succeeded) or we throw.
 */
export function verifyManifestSignature(
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array,
  manifestUrl: string,
  signatureUrl: string,
  // Defaults to the pinned key; overridable only so tests can verify against
  // a throwaway keypair. Production never passes this.
  pubkey: KeyObject = PUBKEY,
): void {
  // ECDSA P-256 over SHA-256. dsaEncoding "der" matches KMS's output (an
  // ASN.1 SEQUENCE of r,s); node hashes manifestBytes with SHA-256 to
  // reproduce the digest KMS signed under ECDSA_SHA_256.
  const ok = verify(
    "sha256",
    manifestBytes,
    { key: pubkey, dsaEncoding: "der" },
    signatureBytes,
  );
  if (!ok) {
    throw new SignatureInvalidError(manifestUrl, signatureUrl);
  }
}
