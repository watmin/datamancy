/**
 * Resource fetch + SHA-256 verification.
 *
 * Every resource content fetched from datamancy.dev is hashed locally
 * and compared against the manifest's expected SHA-256. On mismatch we
 * throw a structured error and refuse to return the content. Tampering
 * cannot reach the LLM.
 */

import { createHash } from "node:crypto";
import type { Resource } from "./manifest.js";
import { DatamancyError } from "./errors.js";
import { readCappedBody } from "./http.js";

export class ResourceFetchError extends DatamancyError {
  readonly severity = "transport";
  readonly audience = "operator";
  constructor(resource: Resource, cause: unknown) {
    super(`Failed to fetch resource ${resource.name} at ${resource.uri}: ${cause}`);
  }
}

export class HashMismatchError extends DatamancyError {
  readonly severity = "verification";
  readonly audience = "operator";
  constructor(
    resource: Resource,
    expectedSha256: string,
    actualSha256: string,
  ) {
    super(
      `Hash mismatch for resource "${resource.name}" at ${resource.uri}: ` +
        `expected ${expectedSha256}, got ${actualSha256}. ` +
        `Resource REJECTED — content will not be passed to the LLM.`,
    );
  }
}

export class SizeMismatchError extends DatamancyError {
  readonly severity = "verification";
  readonly audience = "operator";
  constructor(
    resource: Resource,
    expectedSize: number,
    actualSize: number,
  ) {
    super(
      `Size mismatch for resource "${resource.name}" at ${resource.uri}: ` +
        `expected ${expectedSize} bytes, got ${actualSize}. ` +
        `Resource REJECTED.`,
    );
  }
}

export class EncodingError extends DatamancyError {
  readonly severity = "verification";
  readonly audience = "operator";
  constructor(resource: Resource) {
    super(
      `Resource "${resource.name}" at ${resource.uri} is not valid UTF-8 text. ` +
        `Datamancy spells are UTF-8 text only; refusing to ship a lossy ` +
        `(replacement-char) decode of a binary body. Resource REJECTED.`,
    );
  }
}

export interface FetchedResource {
  resource: Resource;
  /** UTF-8 text content of the resource (post-verification). */
  text: string;
}

/**
 * Fetch a resource by its manifest entry, verify SHA-256 + size, return
 * the content. Throws on any failure — never returns unverified content.
 */
export async function fetchAndVerify(
  resource: Resource,
  signal?: AbortSignal,
  urlOverride?: string,
): Promise<FetchedResource> {
  // Live mode fetches the pretty `uri`; pinned mode passes the immutable
  // `blob`. Verification is always against the manifest entry's hash + size,
  // so the source URL doesn't affect what's accepted.
  const url = urlOverride ?? resource.uri;
  let res: Response;
  try {
    // redirect:"error" — a 3xx can't make the kernel emit an attacker-chosen
    // outbound request (SSRF) before verification. Origin serves directly.
    res = await fetch(url, { signal, redirect: "error" });
  } catch (cause) {
    throw new ResourceFetchError(resource, cause);
  }
  if (!res.ok) {
    throw new ResourceFetchError(resource, `HTTP ${res.status}`);
  }

  let bytes: Uint8Array;
  try {
    // Cap the read at the manifest's declared size: a body longer than
    // promised is a size mismatch, and capping means we never buffer an
    // unbounded body into memory (OOM-proof against a compromised origin).
    // Overflow is VERIFICATION here, not transport — the origin served MORE
    // than the signed manifest declared, which is the manifest and the bytes
    // disagreeing. That routes to the loud half of the gate, and it is the
    // reason overflow cannot carry one fixed class for every caller.
    bytes = await readCappedBody(
      res,
      resource.size,
      (_cap, read) => new SizeMismatchError(resource, resource.size, read),
    );
  } catch (cause) {
    throw cause instanceof SizeMismatchError
      ? cause
      : new ResourceFetchError(resource, cause);
  }

  if (bytes.byteLength !== resource.size) {
    throw new SizeMismatchError(resource, resource.size, bytes.byteLength);
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== resource.sha256) {
    throw new HashMismatchError(resource, resource.sha256, actualSha256);
  }

  // Strict UTF-8: a binary / non-UTF-8 body must fail LOUD, not be silently
  // mangled into U+FFFD replacement chars and shipped to the LLM as if intact.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EncodingError(resource);
  }
  return { resource, text };
}
