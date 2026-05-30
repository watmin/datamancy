/**
 * One error hierarchy for the whole trust path, so the severity that gates
 * behavior is carried STRUCTURALLY, not reconstructed by a hand-maintained
 * instanceof allow-list.
 *
 *   verification — "got bytes, and they're wrong": bad signature / hash / size
 *                  / pin. A tamper signal. Serve last-known-good but LOUD.
 *   transport    — "couldn't get the bytes": timeout / DNS / 5xx. Serve
 *                  last-known-good quietly.
 *   config       — caller/request error: malformed pin, unknown resource,
 *                  version not found. Not a fetch outcome; propagate.
 *
 * Every DatamancyError MUST declare its severity (the field is abstract), so a
 * new error variant cannot be added without classifying it — the wrong shape
 * (an unclassified trust-path error) is uncompilable.
 */

export type Severity = "verification" | "transport" | "config";

export abstract class DatamancyError extends Error {
  abstract readonly severity: Severity;

  constructor(message: string) {
    super(message);
    // Identity is set by construction, not hand-copied per subclass.
    this.name = new.target.name;
  }
}

/** True iff the error is a verification failure — one structural path, no
 *  per-class allow-list to drift out of sync. */
export function isVerificationFailure(err: unknown): boolean {
  return err instanceof DatamancyError && err.severity === "verification";
}

/** A resource URI the verified manifest doesn't list. */
export class UnknownResourceError extends DatamancyError {
  readonly severity = "config";
  constructor(public uri: string) {
    super(
      `Unknown resource: ${uri}. Not present in the verified manifest.`,
    );
  }
}

/** DATAMANCY_PIN was not a 64-char hex SHA-256. */
export class BadPinError extends DatamancyError {
  readonly severity = "config";
  constructor(public given: string) {
    super(
      `DATAMANCY_PIN must be a 64-char hex SHA-256 (optionally ` +
        `"sha256:"-prefixed); got "${given}".`,
    );
  }
}

/** A requested version label is absent from the signed chain. */
export class VersionNotFoundError extends DatamancyError {
  readonly severity = "config";
  constructor(public version: string, public site: string) {
    super(`Version "${version}" not found in the manifest chain at ${site}.`);
  }
}
