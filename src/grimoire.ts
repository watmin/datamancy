/**
 * The grimoire: a verifying client to datamancy.dev, in one of two postures
 * the CONSUMER chooses — not the publisher.
 *
 *   LIVE (default)      — follow the moving `latest` pointer. No boot
 *                         snapshot; always-fetch, so content upgrades the
 *                         instant the website does. (Session state exists —
 *                         a verified memo, the epoch high-water, the spell-set
 *                         baseline — but none of it is ever SERVED in place of
 *                         a live fetch that succeeded.) Fetches each
 *                         spell's pretty `uri`.
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
  UnknownSpellError,
  BadPinError,
  InvariantError,
  VersionNotFoundError,
  PinMismatchError,
  RollbackError,
} from "./errors.js";

/** A manifest paired with the content-address (its SHA-256) that names it. */
export interface VerifiedManifest {
  hash: string;
  manifest: Manifest;
}

/** A manifest load, with whether it came fresh from the origin or from the
 *  last-known-good memo. Carried rather than logged, for the same reason spell
 *  content carries it: stderr is the operator's channel, not the model's. */
interface LoadedManifest extends VerifiedManifest {
  provenance: Provenance;
}

/**
 * How the bytes in hand were obtained. Structural, because the two outcomes are
 * not interchangeable and the type was previously unable to tell them apart:
 * a caller handed `last-known-good` after a hash mismatch must say so, not pass
 * the bytes off as freshly verified. The loud log goes to stderr, which the
 * model on the other end of a tool call never sees.
 */
export type Provenance = "verified" | "last-known-good";

/** The result of reading one spell: the content, how it was obtained, and any
 *  set-change to surface. */
export interface SpellRead {
  fetched: FetchedResource;
  provenance: Provenance;
  setChange: SpellSetChange | null;
}

/** The result of listing: the resolved resources + any set-change to surface,
 *  so a client re-sourcing via resources/list gets the list_changed nudge too. */
export interface SpellList {
  resources: Resource[];
  provenance: Provenance;
  setChange: SpellSetChange | null;
}

// Timeout policy. Cold start (no fallback) gets a generous budget; once a
// verified memo exists, a fetch is bounded so a genuinely STUCK one bails to
// last-known-good. A FIXED, generous bound — not a per-fetch guess derived
// from one noisy baseline sample, which would race a slow-but-fine fetch into
// serving stale. The bound is a hang backstop, not a freshness deadline.
const COLD_TIMEOUT_MS = 15_000;
const WARM_TIMEOUT_MS = 5_000;

// The bounds above are tuned against the public origin. DATAMANCY_SITE lets an
// org serve the grimoire from its own host, and a mirror behind a VPN or auth
// proxy can legitimately be slower than either — with no recourse in a package
// that is never patched, a fixed bound would pin such an operator to
// last-known-good silently and permanently. The override scales both bounds
// together, so their RELATIONSHIP (warm is the tighter backstop) is preserved
// ABOVE the floor; at MIN_TIMEOUT_MS the two coincide, because warm cannot be
// clamped below a bound cold already sits on. The constructor says the same
// where it computes them.
const MIN_TIMEOUT_MS = 1_000;

// `AbortSignal.timeout` is setTimeout-backed, and setTimeout overflows above
// 2**31-1 ms — the delay wraps to ~1ms. So an operator who set
// DATAMANCY_TIMEOUT_MS=3000000000 ("just make it huge") would get a ~1ms budget
// on EVERY fetch: cold boot fails, warm serves last-known-good forever, and the
// only signal is a Node warning on stderr. A larger declared budget producing a
// smaller one is the sharpest edge an escape hatch can have, so it is clamped
// to what the host can actually express.
const MAX_TIMEOUT_MS = 2_147_483_647;

// Bound the chain walk when resolving a version LABEL to a hash. Unbounded, a
// deep or never-matching DATAMANCY_VERSION would fetch+verify the entire signed
// history at boot — a self-inflicted slow start. Older versions stay reachable
// by exact hash pin (DATAMANCY_PIN, which fetches one immutable snapshot).
const MAX_VERSION_WALK = 100;

export interface GrimoireConfig {
  /** Origin, e.g. "https://datamancy.dev". */
  site: string;
  /** DATAMANCY_PIN — a manifest SHA-256 (bare hex, "sha256:" stripped). */
  pinHash?: string | null;
  /** DATAMANCY_VERSION — a friendly version (serverInfo.version / ISO8601). */
  version?: string | null;
  /** DATAMANCY_TIMEOUT_MS — the COLD budget; the warm backstop scales with it.
   *  For an origin slower than the public one (a self-hosted mirror behind a
   *  proxy). Omitted or unparseable → the defaults. */
  timeoutMs?: number | null;
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
  private readonly coldTimeoutMs: number;
  private readonly warmTimeoutMs: number;

  /** Last verified-good manifest (with its hash) — last-known-good fallback. */
  private manifestMemo: VerifiedManifest | null = null;

  /** The one manifest load currently in flight, or null. Read and written only
   *  in `loadManifest`, synchronously around the call — see its header for why
   *  a coalescer (cleared on settle) and never a cache (held after settle). */
  private manifestInFlight: Promise<LoadedManifest> | null = null;
  /** Pinned content is immutable, so it loads exactly once and freezes. */
  private frozenManifest: VerifiedManifest | null = null;
  /** Last-known-good content, STAMPED with the manifest epoch it verified
   *  against. The stamp is what makes the memo monotone: two concurrent reads
   *  straddling a publish each verify correctly against their own manifest, and
   *  whichever resolves LAST would otherwise win — settling the memo on the
   *  OLDER bytes, which every later transport blip then serves as
   *  "last-known-good". Last-to-resolve is not newest. */
  private contentMemo = new Map<string, { fetched: FetchedResource; epoch: number }>();
  /** Sorted spell-name set last seen — detects spell add/remove (live mode). */
  private knownSpellSet: string | null = null;
  /** The manifest epoch the baseline above reflects. Without it the baseline is
   *  ordered by ARRIVAL, and a read that loaded legitimately before a publish
   *  can observe after one that loaded later — rewinding the set and reporting
   *  a removal that never happened upstream. */
  private knownSpellSetEpoch = Number.NEGATIVE_INFINITY;
  /** Highest manifest `epoch` verified this session — the rollback high-water
   *  mark. A live `latest` whose epoch regressed below this is a replay. */
  private highestEpoch = Number.NEGATIVE_INFINITY;

  constructor(
    config: GrimoireConfig,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.site = config.site.replace(/\/+$/, "");
    // CLAMPED, not discarded. A request below the floor used to be thrown away
    // and silently replaced by the 15s default — 30x what was asked — which is
    // the opposite of what an operator lowering it intends.
    const requested = config.timeoutMs;
    const cold =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
        : COLD_TIMEOUT_MS;
    this.coldTimeoutMs = cold;
    // The warm backstop stays proportional, floored at the same minimum. At the
    // floor the two are EQUAL rather than warm being tighter — there is no room
    // below MIN_TIMEOUT_MS for them to differ, and saying so beats a comment
    // promising a relationship the arithmetic cannot hold there.
    this.warmTimeoutMs = Math.max(
      MIN_TIMEOUT_MS,
      Math.round(cold * (WARM_TIMEOUT_MS / COLD_TIMEOUT_MS)),
    );
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

  /** Is this grimoire frozen to one immutable version (by hash or by label)?
   *  The entry point used to re-derive this by re-reading DATAMANCY_PIN and
   *  DATAMANCY_VERSION — a second, independent answer to a question this
   *  object already settled in its constructor, free to disagree with it. */
  isFrozen(): boolean {
    return this.mode === "pinned";
  }

  /**
   * The origin this grimoire actually fetches from — NORMALISED, as the
   * constructor stored it.
   *
   * The entry point printed `process.env.DATAMANCY_SITE` directly instead, and
   * the two normalise differently: the constructor strips trailing slashes and
   * a raw env read does not. So `DATAMANCY_SITE=https://datamancy.dev/` made
   * `datamancy current` compare unequal to the default and tell an operator
   * standing on the canonical origin that the hash was "YOUR mirror's". Same
   * defect as the posture re-derivation `isFrozen` closes, one field over: a
   * second derivation of a question this object already answered.
   */
  origin(): string {
    return this.site;
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

  /**
   * The ONE place a fetch deadline is minted. Cold (no fallback to degrade to)
   * gets the generous budget; warm has a tighter backstop, because a slow
   * origin should lose to a verified copy we already hold.
   *
   * Every fetch is bounded, including the ones no caller passes a signal for.
   * The version walk and the CLI ran unbounded: an origin that accepted the
   * connection and never answered hung `datamancy current`, `datamancy
   * versions`, and — worst — BOOT under DATAMANCY_VERSION, where the client
   * sees a server that never finishes initialize and never errors.
   *
   * The cold/warm selection was a separate `timeoutFor` method, and two of the
   * four fetch sites called it and minted their own `AbortSignal.timeout`
   * instead of coming through here — same value today, and outside any change
   * made to this door tomorrow. Inlined so there is no second thing to call.
   */
  private budget(haveMemo: boolean): AbortSignal {
    return AbortSignal.timeout(
      haveMemo ? this.warmTimeoutMs : this.coldTimeoutMs,
    );
  }

  /**
   * Load the manifest for the active posture, COALESCING concurrent loads.
   *
   * The stdio loop deliberately does not await one request before reading the
   * next, and a JSON-RPC batch dispatches through `Promise.all` — so N loads
   * are genuinely in flight against this one object. Un-coalesced, each did its
   * own manifest fetch, signature fetch and ECDSA verify, and — worse — N loads
   * straddling a publish resolved with DIFFERENT epochs. The later-resolving
   * older one then tripped the rollback guard below and was reported to the
   * operator as `VERIFICATION FAILED … or the content was tampered with`, and
   * to the model as a `STALE_NOTICE` on bytes that were the newest available
   * and had been verified seconds earlier. Two callers, identical bytes,
   * opposite provenance. The race manufactured a tamper alarm and a lie.
   *
   * One shared in-flight promise removes the divergence at its source: within a
   * window there is one fetch, one verify, one epoch, one answer.
   *
   * It is a COALESCER, not a cache — the slot is cleared when the promise
   * settles, including on rejection. Holding a resolved promise would make this
   * the boot snapshot the module header promises it is not, and would freeze
   * the spell set forever; holding a rejected one would make a single transport
   * blip sticky for the life of the process.
   *
   * `observeSetChange` stays OUTSIDE this — it is called by `list()` and
   * `readEntry()` on their own ticks. That placement is load-bearing: moving it
   * inside would compute the diff once and hand the same non-null `setChange`
   * to all N callers, firing N `list_changed` notifications where one is
   * correct, and would break `readEntry`'s advance-after-delivery ordering.
   *
   * One accepted cost: a late joiner inherits the deadline the first caller
   * minted, so it can fall back on a budget it did not fully get. The budget is
   * a hang backstop rather than a freshness deadline, so this is bounded.
   */
  private async loadManifest(): Promise<LoadedManifest> {
    if (this.manifestInFlight) return this.manifestInFlight;
    const load = this.loadManifestUncoalesced();
    this.manifestInFlight = load;
    try {
      return await load;
    } finally {
      this.manifestInFlight = null;
    }
  }

  private async loadManifestUncoalesced(): Promise<LoadedManifest> {
    if (this.mode === "pinned" && this.frozenManifest) {
      // Immutable — loaded once, never re-fetched, and verified when it was.
      return { ...this.frozenManifest, provenance: "verified" };
    }
    if (this.mode === "pinned" && this.pinHash === null) {
      // Version pin not yet resolved — preflight() resolves it first. Guard so
      // an out-of-order direct call can't fetch the nonsense /manifests/null/.
      throw new InvariantError(
        "Pinned-by-version requires preflight() to resolve the version first.",
      );
    }
    const url =
      this.mode === "pinned"
        ? this.snapshotManifestUrl(this.pinHash as string)
        : this.liveManifestUrl();
    const signal = this.budget(this.manifestMemo !== null);
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
      // rune:purgare(safety-margin) — this `live` condition is defensive, not
      // load-bearing: pinned mode loads once and freezes, and the high-water
      // starts at -Infinity, so a pinned load cannot regress and deleting the
      // condition changes no observable behaviour (verified by mutation). It
      // stays so that a future change making pinned mode re-load cannot
      // silently inherit live's rollback semantics for a version the operator
      // deliberately chose.
      if (this.mode === "live") {
        const ep = vm.manifest.epoch; // required field — always present
        if (ep < this.highestEpoch) {
          throw new RollbackError(ep, this.highestEpoch, url);
        }
        this.highestEpoch = ep;
      }
      this.manifestMemo = vm; // remember ONLY verified-good (manifest + its hash)
      if (this.mode === "pinned") this.frozenManifest = vm; // freeze
      return { ...vm, provenance: "verified" };
    } catch (err) {
      if (this.manifestMemo) {
        this.warnFallback(err, "manifest");
        return { ...this.manifestMemo, provenance: "last-known-good" };
      }
      throw err;
    }
  }

  /** Current resource list (uris resolved to the configured origin) PLUS any
   *  spell-SET change since the client last observed. resources/list is the MCP
   *  refresh primitive — a client re-sources through it — so the list_changed
   *  nudge must fire here too, not only on read(); otherwise a list that
   *  straddles an upstream change silently eats it. */
  async list(): Promise<SpellList> {
    const { manifest, provenance } = await this.loadManifest();
    const setChange = this.observeSetChange(manifest);
    return {
      resources: manifest.resources.map((r) => ({
        ...r,
        uri: this.resolve(r.uri),
      })),
      provenance,
      setChange,
    };
  }

  /** Observe the spell-SET change vs the last-known baseline, advancing it. Fully
   *  synchronous (no await between read, advance, diff) so concurrent casts can't
   *  tear it — whichever observes a changed set reports it once and the rest see
   *  the advanced baseline. Shared by list() and read() so the nudge fires on
   *  whichever call the client uses to re-source. */
  private observeSetChange(manifest: Manifest): SpellSetChange | null {
    // Refuse to observe with a manifest OLDER than the one the baseline already
    // reflects. The rollback guard in loadManifest orders the manifests, but it
    // runs on the load's tick and this runs after a content fetch — so a slow
    // read holding a legitimately-loaded older manifest arrives here behind a
    // faster read holding a newer one. Without this check it rewinds the set,
    // fires a fabricated removal, and makes the real change report twice.
    //
    // Check and advance are one synchronous block — no await between the read,
    // the compare, and the two assignments — so concurrent casts cannot tear it.
    if (manifest.epoch < this.knownSpellSetEpoch) return null;
    const prevKey = this.knownSpellSet;
    // The key is minted ONCE and both stored and diffed against. It used to be
    // computed here and then computed again, from the same array, inside
    // spellSetDiff on the very next line.
    const key = Grimoire.spellSetKey(manifest.resources);
    this.knownSpellSet = key;
    this.knownSpellSetEpoch = manifest.epoch;
    return Grimoire.spellSetDiffFrom(prevKey, key, manifest);
  }

  /**
   * Read one resource by its (pretty) URI. Live mode fetches that live `uri`;
   * pinned mode fetches the immutable `blob`. Either way the content is
   * SHA-256 + size verified against the manifest entry.
   */
  async read(uri: string): Promise<SpellRead> {
    // The client passes the resolved (absolute) uri we exposed in list().
    return this.readEntry(
      (r) => this.resolve(r.uri) === uri,
      () => new UnknownResourceError(uri),
    );
  }

  /**
   * Read one spell by its SHORT NAME — what `fetch_spell` speaks, for hosts
   * that only expose tools and so never see `resources/list`.
   *
   * Name→entry resolution happens against the SAME manifest load that the read
   * then uses, so a name can never resolve against one manifest and fetch
   * against another. Everything downstream — signature, hash, size, UTF-8,
   * memo, fallback — is the identical path `read(uri)` takes: one pipeline,
   * two mouths. There is no per-spell branch here and there must never be one;
   * a spell added to the website is a new manifest row, visible with no
   * package change.
   */
  async readByName(name: string): Promise<SpellRead> {
    return this.readEntry(
      (r) => r.name === name,
      // Hand back the catalog from the CURRENT verified manifest — never a
      // baked-in list.
      (manifest) =>
        new UnknownSpellError(
          name,
          manifest.resources.map((r) => r.name).sort(),
        ),
    );
  }

  /**
   * The ONE ordering contract both addressing modes obey: load, resolve the
   * entry, fetch it, and only THEN advance the spell-set baseline.
   *
   * The order is the correctness. `observeSetChange` is a destructive read —
   * it advances `knownSpellSet` and returns the diff exactly once — so a throw
   * between the advance and the caller's `surface()` silently eats the
   * `list_changed` notification for the rest of the session. Advancing last
   * means the baseline moves only on a delivery that actually reaches the
   * caller, and whoever advances it is the one who reports it.
   *
   * That failure was reachable from BOTH read paths and had to be fixed in one
   * place, not two: two copies of an ordering rule is the shape that let the
   * miss path drift from the hit path in the first place.
   */
  private async readEntry(
    select: (r: Resource) => boolean,
    onMiss: (manifest: Manifest) => Error,
  ): Promise<SpellRead> {
    const { manifest, provenance: manifestProvenance } = await this.loadManifest();
    const resource = manifest.resources.find(select);
    if (!resource) {
      throw onMiss(manifest); // baseline untouched — the nudge survives
    }
    const { fetched, provenance: contentProvenance } =
      await this.fetchResource(resource, manifest.epoch);
    // A spell is only "verified" if BOTH the manifest that named it and the
    // bytes it resolved to came fresh. Reporting the content as verified while
    // the manifest behind it was stale would hide half the failure.
    const provenance: Provenance =
      manifestProvenance === "verified" && contentProvenance === "verified"
        ? "verified"
        : "last-known-good";
    return { fetched, provenance, setChange: this.observeSetChange(manifest) };
  }

  /**
   * Fetch + verify one manifest entry, with the last-known-good memo. Keyed by
   * the entry's RESOLVED uri — the same key both read paths produce, so a
   * `fetch_spell` by name and a `resources/read` by uri share one memo entry
   * and can never disagree about a spell's bytes.
   */
  private async fetchResource(
    resource: Resource,
    epoch: number,
  ): Promise<{ fetched: FetchedResource; provenance: Provenance }> {
    // The memo is keyed by the PRETTY uri in both modes, so one spell has one
    // entry however it was fetched. Pinned mode fetches the immutable
    // content-addressed blob (always present — a required field); live mode
    // fetches that same pretty uri, which is why it reuses the key rather than
    // resolving the identical string a second time.
    const key = this.resolve(resource.uri);
    const fetchUrl = this.mode === "pinned" ? this.resolve(resource.blob) : key;
    const signal = this.budget(this.contentMemo.has(key));
    // (has() is a monotone latch — entries are only ever added, never evicted —
    // so a stale read of it can only choose the MORE generous budget.)
    try {
      const fetched = await fetchAndVerify(resource, signal, fetchUrl);
      // Remember ONLY verified-good, and only if it is not OLDER than what is
      // already remembered. The compare-and-set is fully synchronous — no await
      // between the read and the write — so concurrent readers cannot tear it.
      //
      // BEWARE what this does and does not buy. The rollback guard in
      // loadManifest already refuses a regressed epoch and falls back to the
      // highest-epoch memo, so in practice the epoch arriving here is already
      // monotone and this branch is not expected to fire. It does NOT close the
      // equal-epoch case: two manifests published in the same second are both
      // accepted by design, and last-writer-wins still decides between them.
      // Kept as the invariant's local statement — if the rollback guard ever
      // changes, this is the line that keeps the memo from regressing.
      const held = this.contentMemo.get(key);
      if (!held || epoch >= held.epoch) {
        this.contentMemo.set(key, { fetched, epoch });
      }
      return { fetched, provenance: "verified" };
    } catch (err) {
      const memo = this.contentMemo.get(key)?.fetched;
      if (memo) {
        this.warnFallback(err, key);
        // The bytes are previously-verified, but they are NOT what the origin
        // just served. The caller carries that fact onward; it is not a log
        // line's job, because the log goes to stderr and the model reads stdout.
        return { fetched: memo, provenance: "last-known-good" };
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
    // Seed the baseline through the one door that owns it, so "advance the
    // baseline" has a single writer rather than two that must agree.
    this.observeSetChange(vm.manifest);
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
    return Grimoire.spellSetDiffFrom(
      prevKey,
      Grimoire.spellSetKey(manifest.resources),
      manifest,
    );
  }

  /** The diff proper, for a caller that already holds the manifest's key.
   *  `observeSetChange` mints that key to store as the new baseline, so having
   *  it recompute the identical key here was pure duplication. The name list is
   *  built only past the early return — the unchanged case is the common one. */
  private static spellSetDiffFrom(
    prevKey: string | null,
    key: string,
    manifest: Manifest,
  ): SpellSetChange | null {
    if (prevKey === null || prevKey === key) return null;
    const names = manifest.resources.map((r) => r.name);
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
    const { hash, manifest } = await this.fetchOne(
      this.liveManifestUrl(),
      null,
      // No memo to degrade to on this path, so the generous budget is correct.
      this.budget(false),
    );
    return Grimoire.info(hash, manifest);
  }

  /**
   * Walk the signed chain from latest, newest first, yielding each verified
   * (hash, manifest). Each hop is signature-verified and hash-asserted against
   * the link it was reached by — tamper-evident, like git history. The single
   * home for chain traversal; listVersions and resolveVersion both consume it.
   */
  private async *walkChain(
    // Requested bound. CLAMPED below to MAX_VERSION_WALK rather than trusted:
    // `listVersions` is public and passes its argument straight through, so
    // `Infinity` was still one supplied argument away. A bound that can be
    // argued away from outside is a convention, not a structure.
    requestedLimit: number,
  ): AsyncGenerator<VerifiedManifest> {
    const limit = Math.min(requestedLimit, MAX_VERSION_WALK);
    // ONE deadline for the WHOLE walk, created here and threaded through every
    // hop. A per-hop budget bounds each fetch and leaves the walk unbounded:
    // 100 hops × the cold budget is ~25 minutes, which at MCP `initialize`
    // timescales is indistinguishable from the hang this was meant to close.
    const signal = this.budget(false);
    let url = this.liveManifestUrl();
    let expect: string | null = null;
    for (let i = 0; i < limit; i++) {
      const hop = await this.fetchOne(url, expect, signal);
      yield hop;
      if (!hop.manifest.previous) return;
      expect = hop.manifest.previous.replace(/^sha256:/, "");
      url = this.snapshotManifestUrl(expect);
    }
  }

  /**
   * Walk the signed chain from latest, newest first (each hop verified).
   *
   * A LISTING truncates rather than fails. One unfetchable hop used to discard
   * every row already signature-verified above it and exit non-zero — so a
   * single dangling backpointer anywhere in published history made `datamancy
   * versions` print nothing at all, and the operator learned "HTTP 404" instead
   * of "your chain is broken here, and these 17 versions are fine".
   *
   * Two failures are NOT truncated, because truncating them would launder a
   * fact the caller needs:
   *   - a VERIFICATION failure — a bad signature or a hash mismatch mid-walk is
   *     a tamper, and a short list is not an acceptable answer to a tamper;
   *   - a failure on the FIRST hop — there is no partial answer to degrade to,
   *     and "the origin is unreachable" must not read as "no versions exist".
   *
   * `resolveVersion` deliberately does NOT share this: it is a lookup, and a
   * truncated walk cannot prove a label absent. It still throws.
   */
  async listVersions(limit = 50): Promise<VersionInfo[]> {
    const out: VersionInfo[] = [];
    try {
      for await (const { hash, manifest } of this.walkChain(limit)) {
        out.push(Grimoire.info(hash, manifest));
      }
    } catch (err) {
      if (isVerificationFailure(err) || out.length === 0) throw err;
      this.log(
        `chain BROKEN after ${out.length} version(s) — the oldest listed names a ` +
          `previous snapshot the origin did not serve. Listing what verified; ` +
          `history below this point is unreachable by label (an exact ` +
          `DATAMANCY_PIN still works). Cause: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    return out;
  }

  /** Resolve a version label to its manifest hash by walking the chain. */
  private async resolveVersion(version: string): Promise<string> {
    // Bounded — see MAX_VERSION_WALK. A label deeper than this resolves only by
    // exact hash pin, not by name.
    for await (const { hash, manifest } of this.walkChain(MAX_VERSION_WALK)) {
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
