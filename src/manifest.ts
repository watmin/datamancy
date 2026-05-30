/**
 * Manifest fetch + parse for the static MCP server at datamancy.dev.
 *
 * Split into two functions: fetchManifestBytes (raw fetch, no JSON parse)
 * and parseManifest (parse + shape-validate). This split lets us verify
 * the signature against the EXACT bytes the server returned, before any
 * transformation that could change them.
 *
 * The manifest is the trust root: it lists every spell available, with
 * the SHA-256 hash of each spell's content. Downstream code verifies
 * fetched content against these hashes before passing anything to the LLM.
 */

import { DatamancyError } from "./errors.js";
import {
  readCappedBody,
  BodyTooLargeError,
  MAX_MANIFEST_BYTES,
  MAX_RESOURCE_BYTES,
} from "./http.js";

/**
 * The manifest FORMAT major this kernel understands. `schemaVersion` is the
 * publisher's break signal: additive changes (new fields) need no bump and
 * are tolerated; a value GREATER than this means a breaking format the frozen
 * kernel cannot safely interpret, so it refuses LOUD ("upgrade the package")
 * rather than silently misreading a v2 manifest as v1. This is the one number
 * that lets a never-patched client fail honestly instead of guessing.
 */
export const KERNEL_SCHEMA_MAJOR = 1;

export interface Resource {
  /** Short identifier (e.g. "consonare", "intueri"). */
  name: string;
  /** Live URL where the content is served (pretty, browsable). Live mode. */
  uri: string;
  /**
   * Immutable content-addressed URL (`/blobs/sha256/<hash>`). Pinned mode
   * fetches this — it can never change because the URL IS the hash. REQUIRED:
   * a pinned read with no blob would silently fall back to the mutable `uri`,
   * defeating the immutability pinning exists to guarantee.
   */
  blob: string;
  /** MIME type the server commits to serving. */
  mimeType: string;
  /** Hex-encoded SHA-256 of the resource content (64 lowercase hex chars). */
  sha256: string;
  /** Byte length of the resource content. */
  size: number;
  /** Optional human-readable description (shown to the LLM). */
  description?: string;
}

/** The upstream site's identity block. */
export interface ServerInfo {
  name: string;
  /** Friendly version label (ISO8601 at publish time). */
  version: string;
}

/** The manifest's declared trust shape. */
export interface TrustBlock {
  algorithm: "SHA-256";
  tier: number;
  signed: boolean;
}

export interface Manifest {
  /**
   * Document schema major — the break signal. REQUIRED and declared, never
   * inferred: a manifest must state the format it speaks so a frozen kernel
   * refuses a future major loud instead of assuming v1.
   */
  schemaVersion: number;
  serverInfo: ServerInfo;
  /**
   * Content address of the previous manifest — the chain backpointer.
   * REQUIRED (may be `null` at genesis): the field is always present, so
   * "genesis" is stated as `null`, never left ambiguous by omission.
   */
  previous: string | null;
  /**
   * Monotone version stamp (unix seconds at publish). REQUIRED — the kernel's
   * rollback protection on the live `latest` pointer depends on it; an optional
   * epoch would let a no-epoch manifest bypass the gate entirely. An authentic
   * manifest whose epoch regressed below the highest seen this session is
   * refused.
   */
  epoch: number;
  trust: TrustBlock;
  resources: Resource[];
}

/** A lowercase hex SHA-256 (64 chars). Shared so pin + hash checks agree. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** True iff `path` is a string that resolves as a URL (absolute or relative).
 *  Validating here means a malformed uri/blob fails the shape check (a
 *  verification-class ManifestShapeError) before resolve() ever sees it. */
function resolves(path: unknown): path is string {
  if (typeof path !== "string") return false;
  try {
    new URL(path, "https://x/");
    return true;
  } catch {
    return false;
  }
}

function isResource(x: unknown): x is Resource {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    resolves(r.uri) &&
    resolves(r.blob) &&
    typeof r.mimeType === "string" &&
    typeof r.sha256 === "string" &&
    HEX64.test(r.sha256) &&
    typeof r.size === "number" &&
    Number.isFinite(r.size) &&
    r.size >= 0 &&
    // Memory backstop: refuse a declared size beyond what any real spell needs,
    // so a content read can never be asked to buffer an unbounded body.
    r.size <= MAX_RESOURCE_BYTES
  );
}

function isManifest(x: unknown): x is Manifest {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (typeof m.serverInfo !== "object" || m.serverInfo === null) return false;
  const si = m.serverInfo as Record<string, unknown>;
  if (typeof si.name !== "string" || typeof si.version !== "string") return false;
  if (typeof m.trust !== "object" || m.trust === null) return false;
  const t = m.trust as Record<string, unknown>;
  if (t.algorithm !== "SHA-256") return false;
  if (typeof t.tier !== "number") return false;
  if (typeof t.signed !== "boolean") return false;
  if (!Array.isArray(m.resources)) return false;
  if (!m.resources.every(isResource)) return false;
  // Chain/format fields are REQUIRED — no silent-assumption bypass. Every
  // manifest must DECLARE its format major, its chain position (null at
  // genesis), and its freshness stamp.
  // schemaVersion is the break-signal — the one number the "frozen client fails
  // honest on a future format" guarantee rests on. Harden it like `epoch`: a
  // finite POSITIVE INTEGER, never NaN/0/negative/fractional. Critically,
  // `NaN > 1` is false, so a bare `typeof number` check would let `NaN` slip
  // BOTH this gate and the `> KERNEL_SCHEMA_MAJOR` break-signal — a silent
  // misread in the exact mechanism built to prevent silent misreads.
  if (
    typeof m.schemaVersion !== "number" ||
    !Number.isInteger(m.schemaVersion) ||
    m.schemaVersion < 1
  ) {
    return false;
  }
  // `previous` is a content-address — null at genesis, else `sha256:<hex64>`.
  // Gate it as strictly as `sha256` (not merely "string"), so a garbage
  // backpointer can't be interpolated into a fetch URL before the hash
  // assertion that walks the chain ever runs.
  if (
    m.previous !== null &&
    (typeof m.previous !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(m.previous))
  ) {
    return false;
  }
  if (typeof m.epoch !== "number" || !Number.isFinite(m.epoch) || m.epoch < 0) {
    return false;
  }
  return true;
}

export class ManifestFetchError extends DatamancyError {
  readonly severity = "transport";
  constructor(public url: string, public cause?: unknown) {
    super(`Failed to fetch manifest from ${url}: ${cause}`);
  }
}

export class ManifestShapeError extends DatamancyError {
  readonly severity = "verification";
  constructor(public url: string) {
    super(
      `Manifest at ${url} did not validate against expected shape. ` +
        `Refusing to use it — the trust root is corrupt.`,
    );
  }
}

export class ManifestSchemaError extends DatamancyError {
  // A manifest from the future. Verification-class so a long-lived session
  // serves last-known-good LOUD (and a cold boot fails fast) — either way the
  // operator is told to upgrade rather than fed a guessed-at interpretation.
  readonly severity = "verification";
  constructor(
    public url: string,
    public declared: number,
    public supported: number,
  ) {
    super(
      `Manifest at ${url} declares schemaVersion ${declared}, but this ` +
        `datamancy package understands format major ${supported}. This is a ` +
        `newer manifest format — upgrade the datamancy package. Refusing to ` +
        `guess at its meaning.`,
    );
  }
}

/**
 * Fetch the raw manifest bytes (no JSON parse). Used so signature
 * verification operates on the exact bytes the server returned.
 */
export async function fetchManifestBytes(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
      // No redirects: a 3xx from a hosting-only attacker would make the kernel
      // emit an attacker-chosen outbound request (SSRF) BEFORE any verification
      // runs. The origin must serve content directly. redirect:"error" rejects.
      redirect: "error",
    });
  } catch (cause) {
    throw new ManifestFetchError(url, cause);
  }
  if (!res.ok) {
    throw new ManifestFetchError(url, `HTTP ${res.status}`);
  }
  try {
    // Bounded read: a manifest larger than the ceiling can't OOM the process.
    return await readCappedBody(res, MAX_MANIFEST_BYTES);
  } catch (cause) {
    // Over-long or read failure are both transport (we haven't verified yet).
    if (cause instanceof BodyTooLargeError) {
      throw new ManifestFetchError(url, cause.message);
    }
    throw new ManifestFetchError(url, cause);
  }
}

/**
 * Parse + shape-validate manifest bytes. Call this AFTER signature
 * verification has succeeded, never before.
 */
export function parseManifest(bytes: Uint8Array, sourceUrl: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    // Bytes that passed signature verification but aren't valid JSON are a
    // corrupt trust root — a verification-class failure, not a transport blip.
    throw new ManifestShapeError(sourceUrl);
  }
  if (!isManifest(data)) {
    throw new ManifestShapeError(sourceUrl);
  }
  // A schemaVersion newer than this frozen kernel understands is a breaking
  // format we must not interpret. Refuse LOUD (verification-class) — never
  // silently parse a future v2 as if it were v1.
  // schemaVersion is REQUIRED + validated as a number by isManifest above, so
  // it is always present here — no `!== undefined` guard (which would whisper
  // an optionality CONTRACT rule 3a explicitly denies).
  if (data.schemaVersion > KERNEL_SCHEMA_MAJOR) {
    throw new ManifestSchemaError(
      sourceUrl,
      data.schemaVersion,
      KERNEL_SCHEMA_MAJOR,
    );
  }
  return data;
}
