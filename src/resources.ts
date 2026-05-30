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

export class ResourceFetchError extends Error {
  constructor(public resource: Resource, public cause?: unknown) {
    super(`Failed to fetch resource ${resource.name} at ${resource.uri}: ${cause}`);
    this.name = "ResourceFetchError";
  }
}

export class HashMismatchError extends Error {
  constructor(
    public resource: Resource,
    public expectedSha256: string,
    public actualSha256: string,
  ) {
    super(
      `Hash mismatch for resource "${resource.name}" at ${resource.uri}: ` +
        `expected ${expectedSha256}, got ${actualSha256}. ` +
        `Resource REJECTED — content will not be passed to the LLM.`,
    );
    this.name = "HashMismatchError";
  }
}

export class SizeMismatchError extends Error {
  constructor(
    public resource: Resource,
    public expectedSize: number,
    public actualSize: number,
  ) {
    super(
      `Size mismatch for resource "${resource.name}" at ${resource.uri}: ` +
        `expected ${expectedSize} bytes, got ${actualSize}. ` +
        `Resource REJECTED.`,
    );
    this.name = "SizeMismatchError";
  }
}

export interface FetchedResource {
  resource: Resource;
  /** UTF-8 text content of the resource (post-verification). */
  text: string;
  /** Raw bytes (post-verification), in case binary handling is added later. */
  bytes: Uint8Array;
}

/**
 * Fetch a resource by its manifest entry, verify SHA-256 + size, return
 * the content. Throws on any failure — never returns unverified content.
 */
export async function fetchAndVerify(
  resource: Resource,
  signal?: AbortSignal,
): Promise<FetchedResource> {
  let res: Response;
  try {
    res = await fetch(resource.uri, { signal });
  } catch (cause) {
    throw new ResourceFetchError(resource, cause);
  }
  if (!res.ok) {
    throw new ResourceFetchError(resource, `HTTP ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes.byteLength !== resource.size) {
    throw new SizeMismatchError(resource, resource.size, bytes.byteLength);
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== resource.sha256) {
    throw new HashMismatchError(resource, resource.sha256, actualSha256);
  }

  const text = Buffer.from(bytes).toString("utf-8");
  return { resource, text, bytes };
}
