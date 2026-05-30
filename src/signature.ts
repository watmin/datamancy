/**
 * Ed25519 signature verification for the datamancy.dev manifest.
 *
 * The manifest at datamancy.dev/.well-known/mcp/manifest.json is signed
 * by the maintainer's offline private key. The detached signature lives
 * at datamancy.dev/.well-known/mcp/manifest.json.sig. This module fetches
 * the signature and verifies it against the pinned public key.
 *
 * Verification flow:
 *   1. Fetch the raw manifest bytes (not parsed JSON yet — we verify the
 *      exact bytes the server returned, before any transformation)
 *   2. Fetch the raw signature bytes
 *   3. node:crypto verify(null, manifestBytes, PUBKEY, signatureBytes)
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

export async function fetchSignature(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
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
): void {
  // Ed25519: algorithm arg is null; node:crypto infers from key type.
  const ok = verify(null, manifestBytes, PUBKEY, signatureBytes);
  if (!ok) {
    throw new SignatureInvalidError(manifestUrl, signatureUrl);
  }
}
