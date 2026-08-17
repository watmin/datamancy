/**
 * One error hierarchy for the whole trust path, so the severity that gates
 * behavior is carried STRUCTURALLY, not reconstructed by a hand-maintained
 * instanceof allow-list.
 *
 *   verification — "got bytes, and they're wrong": bad signature / hash / size
 *                  / pin. A tamper signal — logged LOUD when a fallback serves.
 *   transport    — "couldn't get the bytes": timeout / DNS / 5xx. Logged
 *                  quietly when a fallback serves.
 *   config       — caller/request error (e.g. a malformed pin, an unknown
 *                  resource). Not a fetch outcome; propagate.
 *
 * Every DatamancyError MUST declare BOTH axes (the fields are abstract), so a
 * new error variant cannot be added without classifying it — the wrong shape
 * (an unclassified trust-path error) is uncompilable.
 *
 * What each axis ACTUALLY drives, stated precisely because an earlier version
 * of this header overclaimed it: `severity` decides the JSON-RPC code
 * (`rpcCode`) and the log REGISTER on a fallback (`isVerificationFailure`
 * picks loud-vs-quiet wording). It does NOT decide *whether* a fallback
 * happens — that is memo presence alone, in grimoire.ts's catch arms. A
 * `config` error thrown inside one of those try blocks with a warm memo would
 * be swallowed into last-known-good, and nothing here prevents it; what keeps
 * caller-faults propagating today is that they are thrown OUTSIDE those
 * blocks. `audience` gates who the failure is reported TO.
 * Neither list above is exhaustive by design: an enumeration in a comment is a
 * hand-list, and hand-lists go stale exactly when a variant is added.
 */

export type Severity =
  | "verification"
  | "transport"
  | "config"
  /** A broken invariant INSIDE this server — nothing the caller did. Propagates
   *  like `config` (no fallback is appropriate), but the wire code says
   *  "internal", because telling a client its parameters were invalid when it
   *  sent none is a lie about whose fault it is. */
  | "internal";

/**
 * WHO a failure is for — the axis `severity` cannot answer.
 *
 *   model    — the caller named something that isn't there and can fix it from
 *              the message (an unknown spell, whose catalog the error carries).
 *              Reaches an LLM as readable tool output it can retry from.
 *   operator — everything else: a tamper, an unreachable origin, a malformed
 *              pin, a tool the handshake never offered. A human must act; the
 *              model can do nothing with it, so it surfaces as a wire fault.
 *
 * Abstract, so a new variant cannot be added without answering it. `severity`
 * alone cannot decide this — UnknownSpellError and UnknownToolError are BOTH
 * "config" and route opposite ways — which is exactly why routing on the class
 * itself (an instanceof allow-list) crept in before this field existed.
 */
export type Audience = "model" | "operator";

/** The two wire codes this hierarchy maps onto (JSON-RPC 2.0 §5.1). Kept here
 *  rather than imported from the protocol layer so the error module stays the
 *  leaf it is — nothing in the trust path depends on the framing. */
const JsonRpcCode = { InvalidParams: -32602, InternalError: -32603 } as const;

export abstract class DatamancyError extends Error {
  abstract readonly severity: Severity;
  abstract readonly audience: Audience;

  constructor(message: string) {
    super(message);
    // Identity is set by construction, not hand-copied per subclass.
    this.name = new.target.name;
  }

  /**
   * The JSON-RPC code this failure surfaces as — DERIVED from severity, never
   * hand-set per class. The mapping IS the semantics: a `config` failure is the
   * caller's request being wrong (InvalidParams); a verification or transport
   * failure is this server unable to deliver (InternalError). Deriving it means
   * a new variant answers one question it already had to answer and gets the
   * wire code right for free — a hand-picked number per class would drift.
   */
  get rpcCode(): (typeof JsonRpcCode)[keyof typeof JsonRpcCode] {
    // Only `config` is the caller's request being wrong. `verification` and
    // `transport` are this server unable to deliver; `internal` is this server
    // broken. All three are InternalError on the wire.
    return this.severity === "config"
      ? JsonRpcCode.InvalidParams
      : JsonRpcCode.InternalError;
  }
}

/** True iff the failure is one the MODEL can act on — one structural path, no
 *  per-class allow-list to drift out of sync (the sibling of
 *  isVerificationFailure, for the axis the tool surface routes on). */
export function isModelAudience(err: unknown): boolean {
  return err instanceof DatamancyError && err.audience === "model";
}

/** True iff the error is a verification failure — one structural path, no
 *  per-class allow-list to drift out of sync. */
export function isVerificationFailure(err: unknown): boolean {
  return err instanceof DatamancyError && err.severity === "verification";
}

/** A resource URI the verified manifest doesn't list. */
export class UnknownResourceError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "operator";
  constructor(uri: string) {
    super(
      `Unknown resource: ${uri}. Not present in the verified manifest.`,
    );
  }
}

/**
 * A spell SHORT NAME the verified manifest doesn't list — the `fetch_spell`
 * miss. Distinct from UnknownResourceError (which names a *uri*): the tool
 * surface is addressed by name, and its miss must hand back the catalog,
 * because a tools-only host has no `resources/list` to learn it from.
 */
export class UnknownSpellError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "model";
  constructor(spell: string, public known: string[]) {
    super(
      `Unknown spell: "${spell}". The verified grimoire lists: ` +
        `${known.join(", ")}.`,
    );
  }
}

/** A tools/call naming a tool this server never listed. */
export class UnknownToolError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "operator";
  constructor(tool: string, public known: string[]) {
    super(
      `Unknown tool: "${tool}". This server offers exactly: ` +
        `${known.join(", ")}.`,
    );
  }
}

/** DATAMANCY_PIN was not a 64-char hex SHA-256. */
export class BadPinError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "operator";
  constructor(given: string) {
    super(
      `DATAMANCY_PIN must be a 64-char hex SHA-256 (optionally ` +
        `"sha256:"-prefixed); got "${given}".`,
    );
  }
}

/** A requested version label is absent from the signed chain. */
export class VersionNotFoundError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "operator";
  constructor(version: string, site: string) {
    super(`Version "${version}" not found in the manifest chain at ${site}.`);
  }
}

/**
 * A request whose PROTOCOL params are malformed — `resources/read` with no
 * uri, `tools/call` with no tool name. The HOST composed these, so the host is
 * who must fix them.
 */
export class BadParamsError extends DatamancyError {
  readonly severity = "config";
  readonly audience = "operator";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A tool call whose ARGUMENTS are wrong — a missing `spell`, a key the schema
 * does not accept, a non-string value.
 *
 * Separate from BadParamsError because the author is different and so is the
 * remedy: a MODEL composed these, and the messages are written for one ("Call
 * list_spells for the names"). Routing them as operator faults meant a model
 * that sent `{"name": …}` instead of `{"spell": …}` got an opaque wire error,
 * while a model that sent a valid-but-unknown spell name got readable output it
 * could retry from — the same recoverability, opposite treatment.
 */
export class BadArgumentsError extends DatamancyError {
  readonly severity = "config";
  // `operator`, NOT `model`, and the reason is the spec rather than taste: MCP
  // `/server/tools` §Error Handling lists "Invalid arguments" under PROTOCOL
  // errors, reserving `isError` results for failures originating INSIDE a tool
  // that ran. An unknown spell name is such a failure — the tool ran and looked
  // — so it stays model-facing. A malformed argument never reached the tool.
  //
  // The class still earns its existence: it names WHO composed the bad call, so
  // the message register is deliberate, and it un-overloads a BadParamsError
  // that was serving three unrelated situations. If the spec ever moves, this
  // is a one-field change instead of an archaeology exercise.
  readonly audience = "operator";
  constructor(message: string) {
    super(message);
  }
}

/**
 * An invariant inside this server was violated — a call made out of the order
 * the code requires. Not the caller's doing, so it must not be reported as
 * their bad parameters.
 */
export class InvariantError extends DatamancyError {
  readonly severity = "internal";
  readonly audience = "operator";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A `latest` manifest whose monotone `epoch` regressed below the highest we've
 * verified this session — an authentic-but-stale manifest replayed to roll a
 * consumer back to older content (TUF rollback). Verification-class: serve
 * last-known-good LOUD, never the stale bytes.
 */
export class RollbackError extends DatamancyError {
  readonly severity = "verification";
  readonly audience = "operator";
  constructor(
    served: number,
    highest: number,
    url: string,
  ) {
    super(
      `Rollback detected at ${url}: served manifest epoch ${served} is older ` +
        `than the highest verified epoch ${highest} seen this session. An ` +
        `older 'latest' is a replay/rollback — REFUSING, serving ` +
        `last-known-good.`,
    );
  }
}

/** A pinned manifest whose bytes don't hash to the requested pin. */
export class PinMismatchError extends DatamancyError {
  readonly severity = "verification";
  readonly audience = "operator";
  constructor(
    expected: string,
    actual: string,
    url: string,
  ) {
    super(
      `Pin mismatch at ${url}: expected sha256:${expected}, got ` +
        `sha256:${actual}. The bytes served for this pinned version do not ` +
        `match the requested hash — REFUSING.`,
    );
  }
}
