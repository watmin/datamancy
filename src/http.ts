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
    // No stream available (not expected from Node's fetch, but be safe): fall
    // back to arrayBuffer, then still enforce the cap so we never RETURN more
    // than the bound even if we briefly buffered it.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes, buf.byteLength);
    }
    return buf;
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
