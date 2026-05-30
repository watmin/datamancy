/**
 * The live grimoire: a stateless verifying pass-through to datamancy.dev.
 *
 * It's a static website, so this adapter holds no boot snapshot and needs
 * no reload verb. Every list/read fetches the manifest FRESH and verifies
 * it against the pinned public key, so content upgrades the instant the
 * website does. The only "reload" is the client re-reading a resource —
 * and since the grimoire index is itself a resource, re-reading it yields
 * the current catalog with no server involvement.
 *
 * The one stateful concession is the memo: a write-only-on-verified cache
 * that lets a transient network failure serve last-known-good instead of
 * blanking. The rule is absolute — only verified content is ever
 * remembered, so the memo can never hold anything forged. RAM is inside
 * the trust boundary (an attacker who can rewrite it already owns the
 * pinned pubkey beside it), so memoized content is served directly, never
 * re-verified.
 *
 * Failure handling distinguishes by SIGNAL, not behavior:
 *   - transport failure (timeout/DNS/5xx)      → serve last-good, INFO log
 *   - verification failure (bad sig/hash/size) → serve last-good, LOUD log
 *     ("a scary event just happened") — a tamper must never be silent
 *   - no memo yet                              → refuse (cold start)
 */

import {
  fetchManifestBytes,
  parseManifest,
  type Manifest,
  type Resource,
} from "./manifest.js";
import {
  fetchSignature,
  verifyManifestSignature,
  SignatureInvalidError,
} from "./signature.js";
import {
  fetchAndVerify,
  HashMismatchError,
  SizeMismatchError,
  type FetchedResource,
} from "./resources.js";

/**
 * A verification failure means "got bytes, and they're wrong" — a tamper
 * signal. A transport failure means "couldn't get the bytes." Only the
 * former is loud; both fall back to last-known-good.
 */
function isVerificationFailure(err: unknown): boolean {
  return (
    err instanceof SignatureInvalidError ||
    err instanceof HashMismatchError ||
    err instanceof SizeMismatchError
  );
}

// Timeout policy. Cold start (no memo) must succeed, so it gets a generous
// budget. Once we hold a verified memo, fetches are bounded TIGHT — there's
// a safe fallback, so there's no reason to wait long for fresh. The warm
// bound is adaptive: ~3x the measured baseline latency (so it auto-tunes to
// the consumer's network), clamped to a floor (a pure 3x of a fast baseline
// would trip on normal jitter) and a ceiling (we have last-known-good; never
// hang). Past the bound, the fetch aborts → transport failure → serve memo.
const COLD_TIMEOUT_MS = 15_000;
const WARM_MULTIPLIER = 3;
const WARM_FLOOR_MS = 750;
const WARM_CEIL_MS = 5_000;

export class Grimoire {
  private manifestMemo: Manifest | null = null;
  private contentMemo = new Map<string, FetchedResource>();
  private baselineMs: number | null = null;

  constructor(
    private readonly manifestUrl: string,
    private readonly signatureUrl: string,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /**
   * Fetch + verify the live manifest. On success, refresh the memo and
   * return it. On failure, fall back to last-known-good if present (loud
   * on verification failure), else rethrow — a cold start with no good
   * manifest cannot be faked into trust.
   */
  private async loadManifest(): Promise<Manifest> {
    // Warm if we already hold a verified manifest to fall back to.
    const signal = AbortSignal.timeout(this.timeoutFor(this.manifestMemo !== null));
    try {
      // Manifest and signature are independent — fetch them concurrently so
      // a load costs one round trip, not two.
      const [bytes, sig] = await Promise.all([
        fetchManifestBytes(this.manifestUrl, signal),
        fetchSignature(this.signatureUrl, signal),
      ]);
      verifyManifestSignature(bytes, sig, this.manifestUrl, this.signatureUrl);
      const manifest = parseManifest(bytes, this.manifestUrl);
      this.manifestMemo = manifest; // remember ONLY verified-good
      return manifest;
    } catch (err) {
      if (this.manifestMemo) {
        this.warnFallback(err, "manifest");
        return this.manifestMemo;
      }
      throw err;
    }
  }

  /** Cold (no fallback) gets a generous budget; warm is bounded tight. */
  private timeoutFor(haveMemo: boolean): number {
    if (!haveMemo) return COLD_TIMEOUT_MS;
    const adaptive = WARM_MULTIPLIER * (this.baselineMs ?? WARM_CEIL_MS);
    return Math.min(Math.max(adaptive, WARM_FLOOR_MS), WARM_CEIL_MS);
  }

  /** Current resource list, fetched fresh. */
  async list(): Promise<Resource[]> {
    const manifest = await this.loadManifest();
    return manifest.resources;
  }

  /**
   * Read one resource by URI. Fetches the live manifest (for the current
   * expected hash), then fetches + verifies the content. Memo fallback on
   * failure, by the same rules as the manifest.
   */
  async read(uri: string): Promise<FetchedResource> {
    const manifest = await this.loadManifest();
    const resource = manifest.resources.find((r) => r.uri === uri);
    if (!resource) {
      throw new Error(
        `Unknown resource: ${uri}. Not present in the verified manifest.`,
      );
    }
    const signal = AbortSignal.timeout(this.timeoutFor(this.contentMemo.has(uri)));
    try {
      const fetched = await fetchAndVerify(resource, signal);
      this.contentMemo.set(uri, fetched); // remember ONLY verified-good
      return fetched;
    } catch (err) {
      const memo = this.contentMemo.get(uri);
      if (memo) {
        this.warnFallback(err, uri);
        return memo;
      }
      throw err;
    }
  }

  /**
   * Startup self-test: fail fast if the live manifest is unreachable or
   * its signature is invalid at launch. Seeds the manifest memo so a
   * network blip immediately after boot still has a fallback.
   */
  async preflight(): Promise<Manifest> {
    const t0 = Date.now();
    const manifest = await this.loadManifest(); // cold: no memo yet
    this.baselineMs = Date.now() - t0;
    this.log(
      `baseline latency ${this.baselineMs}ms → warm fetch bound ` +
        `${this.timeoutFor(true)}ms (serve last-known-good past that)`,
    );
    return manifest;
  }

  private warnFallback(err: unknown, what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (isVerificationFailure(err)) {
      this.log(
        `⚠️  VERIFICATION FAILED for ${what} — a scary event just happened. ` +
          `Either the website updated and this is a stale read (re-read the ` +
          `grimoire), or the content was tampered with. Serving ` +
          `last-known-good; the bad bytes were NOT remembered. Cause: ${msg}`,
      );
    } else {
      this.log(
        `transport failure for ${what}; serving last-known-good. Cause: ${msg}`,
      );
    }
  }
}
