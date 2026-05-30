/**
 * The grimoire: a verifying client to datamancy.dev, in one of two postures
 * the CONSUMER chooses — not the publisher.
 *
 *   LIVE (default)      — follow the moving `latest` pointer. Stateless
 *                         always-fetch; content upgrades the instant the
 *                         website does. Fetches each spell's pretty `uri`.
 *   PINNED              — freeze to one audited immutable version. Set
 *                         DATAMANCY_PIN=sha256:<manifest-hash> (strongest:
 *                         trusts nothing but the hash) or DATAMANCY_VERSION=
 *                         <label> (the ISO8601 version, resolved by walking
 *                         the signed chain). Fetches each spell's immutable
 *                         `blob`. Loaded once, then frozen by construction.
 *
 * Trust in both modes: every manifest is ECDSA P-256 verified against the
 * pinned public key; every spell body is SHA-256 verified before release.
 * Pinned mode adds: the manifest's own bytes must hash to the pinned value.
 *
 * Resilience (live mode): a write-only-on-verified memo serves last-known-good
 * on a transient transport failure (quiet) and on a verification failure
 * (LOUD — a tamper is never silent); the bad bytes are never remembered.
 */

import { createHash, type KeyObject } from "node:crypto";

import {
  fetchManifestBytes,
  parseManifest,
  HEX64,
  type Manifest,
  type Resource,
} from "./manifest.js";
import { fetchSignature, verifyManifestSignature } from "./signature.js";
import { fetchAndVerify, type FetchedResource } from "./resources.js";
import {
  isVerificationFailure,
  UnknownResourceError,
  BadPinError,
  BadParamsError,
  VersionNotFoundError,
  PinMismatchError,
  RollbackError,
} from "./errors.js";

/** A manifest paired with the content-address (its SHA-256) that names it. */
export interface VerifiedManifest {
  hash: string;
  manifest: Manifest;
}

/** The result of reading one spell: verified content + any set-change to surface. */
export interface SpellRead {
  fetched: FetchedResource;
  setChange: SpellSetChange | null;
}

// Timeout policy. Cold start (no fallback) gets a generous budget; once a
// verified memo exists, a fetch is bounded so a genuinely STUCK one bails to
// last-known-good. A FIXED, generous bound — not a per-fetch guess derived
// from one noisy baseline sample, which would race a slow-but-fine fetch into
// serving stale. The bound is a hang backstop, not a freshness deadline.
const COLD_TIMEOUT_MS = 15_000;
const WARM_TIMEOUT_MS = 5_000;

export interface GrimoireConfig {
  /** Origin, e.g. "https://datamancy.dev". */
  site: string;
  /** DATAMANCY_PIN — a manifest SHA-256 (bare hex, "sha256:" stripped). */
  pinHash?: string | null;
  /** DATAMANCY_VERSION — a friendly version (serverInfo.version / ISO8601). */
  version?: string | null;
  /**
   * Override the manifest-verification key. Defaults to the pinned production
   * key; only tests pass this (with a throwaway keypair) to exercise the
   * trust gate hermetically — the real KMS key is non-exportable.
   */
  verifyKey?: KeyObject;
}

export interface VersionInfo {
  /** Friendly label (serverInfo.version — ISO8601 at publish time). */
  version: string;
  /** The content address you pin: the manifest's own SHA-256. */
  hash: string;
  /** Number of spells in this version. */
  resources: number;
}

/** A change to the SPELL SET (names added/removed) — not a content edit. */
export interface SpellSetChange {
  version: string;
  added: string[];
  removed: string[];
}

export class Grimoire {
  private readonly site: string;
  private readonly mode: "live" | "pinned";
  /** Resolved manifest hash for pinned mode (from pinHash or version walk). */
  private pinHash: string | null;
  private readonly version: string | null;
  /** Verification key (default pinned; tests override — see GrimoireConfig). */
  private readonly verifyKey?: KeyObject;

  /** Last verified-good manifest (with its hash) — last-known-good fallback. */
  private manifestMemo: VerifiedManifest | null = null;
  /** Pinned content is immutable, so it loads exactly once and freezes. */
  private frozenManifest: VerifiedManifest | null = null;
  private contentMemo = new Map<string, FetchedResource>();
  /** Sorted spell-name set last seen — detects spell add/remove (live mode). */
  private knownSpellSet: string | null = null;
  /** Highest manifest `epoch` verified this session — the rollback high-water
   *  mark. A live `latest` whose epoch regressed below this is a replay. */
  private highestEpoch = Number.NEGATIVE_INFINITY;

  constructor(
    config: GrimoireConfig,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.site = config.site.replace(/\/+$/, "");
    this.version = config.version ?? null;
    this.verifyKey = config.verifyKey;
    if (config.pinHash) {
      if (!HEX64.test(config.pinHash)) {
        throw new BadPinError(config.pinHash);
      }
      this.mode = "pinned";
      this.pinHash = config.pinHash;
    } else if (config.version) {
      this.mode = "pinned";
      this.pinHash = null; // resolved at preflight via chain walk
    } else {
      this.mode = "live";
      this.pinHash = null;
    }
  }

  /** Human-readable description of the active posture (for boot logs). */
  describe(): string {
    if (this.mode === "live") return "LIVE (following latest)";
    if (this.pinHash) return `PINNED sha256:${this.pinHash}`;
    return `PINNED version:${this.version} (resolving)`;
  }

  private liveManifestUrl(): string {
    return `${this.site}/.well-known/mcp/manifest.json`;
  }

  private snapshotManifestUrl(hash: string): string {
    return `${this.site}/manifests/${hash}/manifest.json`;
  }

  /**
   * Resolve a manifest path against the configured origin. Manifests carry
   * origin-agnostic paths (e.g. "/blobs/sha256/<hash>"), so an org can clone
   * a snapshot and serve it from its own host by setting DATAMANCY_SITE —
   * the bytes are verified by signature + hash, never by where they live.
   * (An absolute URL passed here is returned unchanged.)
   */
  private resolve(pathOrUrl: string): string {
    return new URL(pathOrUrl, `${this.site}/`).toString();
  }

  /** Cold (no fallback) gets a generous budget; warm has a fixed backstop. */
  private timeoutFor(haveMemo: boolean): number {
    return haveMemo ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS;
  }

  /**
   * Load the manifest for the active posture. Live: fetch the moving latest,
   * fresh each call, memo fallback. Pinned: fetch the immutable snapshot
   * once, assert its hash equals the pin, then freeze it.
   */
  private async loadManifest(): Promise<VerifiedManifest> {
    if (this.mode === "pinned" && this.frozenManifest) {
      return this.frozenManifest; // immutable — loaded once, never re-fetched
    }
    if (this.mode === "pinned" && this.pinHash === null) {
      // Version pin not yet resolved — preflight() resolves it first. Guard so
      // an out-of-order direct call can't fetch the nonsense /manifests/null/.
      throw new BadParamsError(
        "Pinned-by-version requires preflight() to resolve the version first.",
      );
    }
    const url =
      this.mode === "pinned"
        ? this.snapshotManifestUrl(this.pinHash as string)
        : this.liveManifestUrl();
    const signal = AbortSignal.timeout(
      this.timeoutFor(this.manifestMemo !== null),
    );
    const expectHash = this.mode === "pinned" ? this.pinHash : null;
    try {
      const vm = await this.fetchOne(url, expectHash, signal);
      // Rollback protection (live mode): the signed manifest carries a monotone
      // `epoch`. Refuse a `latest` whose epoch regressed below the highest we've
      // verified this session — an authentic-but-STALE manifest replayed by a
      // mirror/network attacker (TUF rollback). The check+advance is fully
      // synchronous (no await between read, compare, assign), so concurrent
      // loads can't race it: whichever verified manifest resolves first sets the
      // high-water mark; a later-resolving OLDER one is rejected here — before it
      // can overwrite the memo, rewind the spell set, or re-emit list_changed.
      if (this.mode === "live") {
        const ep = vm.manifest.epoch; // required field — always present
        if (ep < this.highestEpoch) {
          throw new RollbackError(ep, this.highestEpoch, url);
        }
        this.highestEpoch = ep;
      }
      this.manifestMemo = vm; // remember ONLY verified-good (manifest + its hash)
      if (this.mode === "pinned") this.frozenManifest = vm; // freeze
      return vm;
    } catch (err) {
      if (this.manifestMemo) {
        this.warnFallback(err, "manifest");
        return this.manifestMemo;
      }
      throw err;
    }
  }

  /** Current resource list, with uris resolved to the configured origin. */
  async list(): Promise<Resource[]> {
    const { manifest } = await this.loadManifest();
    // The client now sees the current set — advance the baseline.
    this.knownSpellSet = Grimoire.spellSetKey(manifest.resources);
    return manifest.resources.map((r) => ({ ...r, uri: this.resolve(r.uri) }));
  }

  /**
   * Read one resource by its (pretty) URI. Live mode fetches that live `uri`;
   * pinned mode fetches the immutable `blob`. Either way the content is
   * SHA-256 + size verified against the manifest entry.
   */
  async read(uri: string): Promise<SpellRead> {
    const { manifest } = await this.loadManifest();
    // Detect a spell-SET change vs what the client last saw, then advance the
    // baseline. Returned as a value (never stashed). The capture+advance is
    // synchronous (no await between), so a concurrent cast can't tear it:
    // whichever cast first observes a changed set reports it once and the rest
    // see the advanced baseline (list_changed is a broadcast — which cast
    // carries it is irrelevant).
    const prevKey = this.knownSpellSet;
    this.knownSpellSet = Grimoire.spellSetKey(manifest.resources);
    const setChange = Grimoire.spellSetDiff(prevKey, manifest);

    // The client passes the resolved (absolute) uri we exposed in list().
    const resource = manifest.resources.find(
      (r) => this.resolve(r.uri) === uri,
    );
    if (!resource) {
      throw new UnknownResourceError(uri);
    }
    // Pinned mode fetches the immutable content-addressed blob (always present
    // — a required field); live mode fetches the pretty uri.
    const path = this.mode === "pinned" ? resource.blob : resource.uri;
    const fetchUrl = this.resolve(path);
    const signal = AbortSignal.timeout(
      this.timeoutFor(this.contentMemo.has(uri)),
    );
    try {
      const fetched = await fetchAndVerify(resource, signal, fetchUrl);
      this.contentMemo.set(uri, fetched); // remember ONLY verified-good
      return { fetched, setChange };
    } catch (err) {
      const memo = this.contentMemo.get(uri);
      if (memo) {
        this.warnFallback(err, uri);
        return { fetched: memo, setChange };
      }
      throw err;
    }
  }

  /**
   * Startup: resolve a version pin to a hash (if needed), then load the
   * manifest once to fail fast on misconfiguration and seed the memo.
   */
  async preflight(): Promise<VerifiedManifest> {
    if (this.mode === "pinned" && this.pinHash === null && this.version) {
      this.pinHash = await this.resolveVersion(this.version);
      this.log(`resolved version ${this.version} → sha256:${this.pinHash}`);
    }
    const vm = await this.loadManifest();
    this.knownSpellSet = Grimoire.spellSetKey(vm.manifest.resources);
    return vm;
  }

  /**
   * One verified hop: fetch the manifest + signature, verify the signature,
   * hash the bytes (asserting against an expected pin if given), parse. The
   * SINGLE home for the verify→hash→pin→parse sequence — loadManifest and the
   * chain walk both go through here, so the trust core lives in one place.
   */
  private async fetchOne(
    url: string,
    expectHash: string | null,
    signal?: AbortSignal,
  ): Promise<VerifiedManifest> {
    const sigUrl = `${url}.sig`;
    const [bytes, sig] = await Promise.all([
      fetchManifestBytes(url, signal),
      fetchSignature(sigUrl, signal),
    ]);
    verifyManifestSignature(bytes, sig, url, sigUrl, this.verifyKey);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (expectHash && hash !== expectHash) {
      throw new PinMismatchError(expectHash, hash, url);
    }
    return { hash, manifest: parseManifest(bytes, url) };
  }

  private static info(hash: string, m: Manifest): VersionInfo {
    return {
      version: m.serverInfo.version,
      hash,
      resources: m.resources.length,
    };
  }

  private static spellSetKey(resources: Resource[]): string {
    return resources
      .map((r) => r.name)
      .sort()
      .join("\n");
  }

  /** Pure: the spell-set change from a previous key to a manifest, or null if
   *  unchanged (or no prior baseline). Content edits don't change the set. */
  static spellSetDiff(
    prevKey: string | null,
    manifest: Manifest,
  ): SpellSetChange | null {
    const names = manifest.resources.map((r) => r.name);
    const key = Grimoire.spellSetKey(manifest.resources);
    if (prevKey === null || prevKey === key) return null;
    const prevSet = new Set(prevKey.split("\n"));
    const curSet = new Set(names);
    return {
      version: manifest.serverInfo.version,
      added: names.filter((n) => !prevSet.has(n)),
      removed: [...prevSet].filter((n) => !curSet.has(n)),
    };
  }

  /** The current (latest) version. */
  async currentVersion(): Promise<VersionInfo> {
    const { hash, manifest } = await this.fetchOne(this.liveManifestUrl(), null);
    return Grimoire.info(hash, manifest);
  }

  /**
   * Walk the signed chain from latest, newest first, yielding each verified
   * (hash, manifest). Each hop is signature-verified and hash-asserted against
   * the link it was reached by — tamper-evident, like git history. The single
   * home for chain traversal; listVersions and resolveVersion both consume it.
   */
  private async *walkChain(
    limit = Number.POSITIVE_INFINITY,
  ): AsyncGenerator<VerifiedManifest> {
    let url = this.liveManifestUrl();
    let expect: string | null = null;
    for (let i = 0; i < limit; i++) {
      const hop = await this.fetchOne(url, expect);
      yield hop;
      if (!hop.manifest.previous) return;
      expect = hop.manifest.previous.replace(/^sha256:/, "");
      url = this.snapshotManifestUrl(expect);
    }
  }

  /** Walk the signed chain from latest, newest first (each hop verified). */
  async listVersions(limit = 50): Promise<VersionInfo[]> {
    const out: VersionInfo[] = [];
    for await (const { hash, manifest } of this.walkChain(limit)) {
      out.push(Grimoire.info(hash, manifest));
    }
    return out;
  }

  /** Resolve a version label to its manifest hash by walking the chain. */
  private async resolveVersion(version: string): Promise<string> {
    for await (const { hash, manifest } of this.walkChain()) {
      if (manifest.serverInfo.version === version) return hash;
    }
    throw new VersionNotFoundError(version, this.site);
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
