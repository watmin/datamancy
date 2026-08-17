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

import type { DatamancyError } from "./errors.js";

/**
 * How a caller classifies an overflow.
 *
 * Overflow means different things at different call sites — an over-ceiling
 * MANIFEST is a transport failure (we never got usable bytes), while an
 * over-declared-size CONTENT body is a verification failure (the origin served
 * more than the signed manifest promised), and those route to opposite halves
 * of the loud/quiet gate. This function is how the call site says which.
 *
 * Taking it as a REQUIRED argument is the point. Overflow used to throw a bare
 * `BodyTooLargeError` that sat outside the error hierarchy — unable to declare
 * either axis — and three call sites each hand-wrote an `instanceof` catch to
 * put it back. Three copies of a classification is the hand-maintained
 * allow-list `errors.ts` opens by forbidding, and a fourth caller that forgot
 * the catch would have shipped an unclassified error onto the wire and turned
 * a verification failure into a quiet transport blip. Now a capped read cannot
 * be obtained without answering the question.
 */
export type OverflowClassifier = (cap: number, read: number) => DatamancyError;

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
 * `maxBytes`. Returns the exact bytes (≤ maxBytes). On overflow the stream is
 * cancelled first, then `onOverflow` builds the error this call site wants —
 * so nothing further is buffered and nothing escapes unclassified. Any other
 * read failure propagates to the caller to classify as transport.
 */
export async function readCappedBody(
  res: Response,
  maxBytes: number,
  onOverflow: OverflowClassifier,
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
        throw onOverflow(maxBytes, total);
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
