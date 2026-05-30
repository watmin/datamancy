/**
 * Bounded HTTP body reading.
 *
 * The trust path must never buffer an unbounded response body. `fetch()`'s
 * `arrayBuffer()` reads the entire body into memory BEFORE any size check can
 * fire — so a compromised origin (or CDN) serving a body far larger than the
 * manifest declares would exhaust memory and get the process OOM-killed
 * (SIGKILL — uncatchable, no last-known-good fallback) before the size
 * mismatch is ever detected.
 *
 * `readCappedBody` streams the body and aborts the moment cumulative bytes
 * exceed a known bound — for content that bound is the manifest's declared
 * `size` (an over-long body IS a size mismatch); for the manifest and the
 * signature it is a generous fixed ceiling. Memory is bounded by the cap plus
 * one chunk, no matter what the origin sends.
 */

/** A body exceeded its cap before fully reading — carries how far it got. */
export class BodyTooLargeError extends Error {
  constructor(
    public readonly cap: number,
    public readonly read: number,
  ) {
    super(`Response body exceeded the ${cap}-byte cap (read at least ${read}).`);
    this.name = "BodyTooLargeError";
  }
}

/** Fixed ceilings for bodies with no manifest-declared size. Manifests are
 *  small JSON; a detached P-256 DER signature is ~72 bytes. Generous, but
 *  finite — the whole point is that memory can't be driven unbounded. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB
export const MAX_SIGNATURE_BYTES = 16 * 1024; // 16 KiB

/**
 * A memory backstop on a resource's DECLARED size. Content reads are capped at
 * `resource.size`, but that size comes from the manifest — so without a ceiling
 * a manifest declaring `size: 8e9` (only possible with the signing key, but
 * still) could drive an 8 GB buffer. A markdown spell is a few KB; 16 MiB is
 * ~1700× the largest real spell, so this never bites legitimate content while
 * guaranteeing EVERY memory path is bounded, at every trust level.
 */
export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Read a fetch Response body, streaming, aborting if cumulative bytes exceed
 * `maxBytes`. Returns the exact bytes (≤ maxBytes). Throws BodyTooLargeError
 * on overflow (the stream is cancelled first, so nothing further is buffered);
 * any other read failure propagates to the caller to classify as transport.
 */
export async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = res.body;
  if (!body) {
    // A null body is a bodyless response (no content) — zero bytes by the fetch
    // spec. Return empty rather than calling unbounded arrayBuffer(), so the
    // memory-bounded-by-cap invariant is TOTAL: no branch can ever buffer an
    // unbounded body. Downstream size/hash/signature checks reject this for any
    // resource that declares content.
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes, total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
