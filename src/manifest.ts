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

export interface Resource {
  /** Short identifier (e.g. "consonare", "intueri"). */
  name: string;
  /** Absolute URL where the resource content lives. */
  uri: string;
  /** MIME type the server commits to serving. */
  mimeType: string;
  /** Hex-encoded SHA-256 of the resource content (64 lowercase hex chars). */
  sha256: string;
  /** Byte length of the resource content. */
  size: number;
  /** Version string (typically the git short SHA at publish time). */
  version?: string;
  /** Optional human-readable description (shown to the LLM). */
  description?: string;
}

export interface Manifest {
  serverInfo: {
    name: string;
    version: string;
  };
  practitioner?: string;
  trust: {
    algorithm: "SHA-256";
    tier: number;
    signed: boolean;
  };
  resources: Resource[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function isResource(x: unknown): x is Resource {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.uri === "string" &&
    typeof r.mimeType === "string" &&
    typeof r.sha256 === "string" &&
    HEX64.test(r.sha256) &&
    typeof r.size === "number" &&
    Number.isFinite(r.size) &&
    r.size >= 0
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
  return true;
}

export class ManifestFetchError extends Error {
  constructor(public url: string, public cause?: unknown) {
    super(`Failed to fetch manifest from ${url}: ${cause}`);
    this.name = "ManifestFetchError";
  }
}

export class ManifestShapeError extends Error {
  constructor(public url: string) {
    super(
      `Manifest at ${url} did not validate against expected shape. ` +
        `Refusing to use it — the trust root is corrupt.`,
    );
    this.name = "ManifestShapeError";
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
    });
  } catch (cause) {
    throw new ManifestFetchError(url, cause);
  }
  if (!res.ok) {
    throw new ManifestFetchError(url, `HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Parse + shape-validate manifest bytes. Call this AFTER signature
 * verification has succeeded, never before.
 */
export function parseManifest(bytes: Uint8Array, sourceUrl: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch (cause) {
    throw new ManifestFetchError(sourceUrl, `invalid JSON: ${cause}`);
  }
  if (!isManifest(data)) {
    throw new ManifestShapeError(sourceUrl);
  }
  return data;
}
