/**
 * MCP (Model Context Protocol) handlers on top of the JSON-RPC stdio
 * framing in protocol.ts.
 *
 * Spec: https://modelcontextprotocol.io
 * Protocol version: we ECHO the client's requested version when it's one we
 * can serve identically (SERVICEABLE_PROTOCOL_VERSIONS), else offer our
 * default (2024-11-05). Both are spec-compliant; echoing keeps a future
 * protocol bump from forcing a client disconnect on this frozen server.
 *
 * Two capabilities, one library. `resources` is the honest shape for a
 * catalog of documents — list, read, done. `tools` exists because many hosts
 * only wire tools through to the agent (and some call `tools/list`
 * unconditionally and read `-32601` as a dead server, though the spec forbids
 * asking for a capability that wasn't advertised). So we advertise two
 * tools — `list_spells` and `fetch_spell` — a second mouth on the resources
 * pipeline: same
 * manifest, same signature check, same hashes, same bytes. No prompts, no
 * sampling, no subscriptions. Datamancy spells are static markdown,
 * hash-verified (and UTF-8-checked) at read time — `fetch_spell` delivers a
 * spell's text; it never casts one.
 *
 * The full MCP spec includes many more methods; we ignore everything we
 * don't implement and the protocol layer returns MethodNotFound for any
 * unsupported method. Clients are expected to discover capabilities via
 * the `initialize` handshake and degrade gracefully.
 */

import { StdioServer } from "./protocol.js";
import {
  BadParamsError,
  BadArgumentsError,
  UnknownToolError,
  isModelAudience,
  DatamancyError,
} from "./errors.js";
import type { CodedError } from "./protocol.js";

/**
 * The wire-code contract, asserted at compile time.
 *
 * `protocol.ts` reads `rpcCode` structurally so the framing layer never learns
 * which error classes exist — right, but it left producer and consumer joined
 * by a string appearing in two files. Rename or mistype it on either side and
 * every error silently reverts to InternalError with no compile error: the
 * exact defect the interface was added to fix, reintroducible by a rename.
 * This line is what makes that a build failure instead.
 */
const _rpcCodeContract: CodedError = null as unknown as DatamancyError;
void _rpcCodeContract;

/**
 * Default protocol version — what we offer when the client's requested version
 * isn't one we recognize (a spec-compliant "respond with a version we support").
 */
export const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/**
 * Protocol versions this server can serve identically. We expose `resources`
 * (list + read + listChanged) and a single text-returning tool — both shapes
 * are unchanged across these MCP revisions (2025-06-18 adds only OPTIONAL
 * `outputSchema`/`structuredContent`, which a text tool need not carry) — so
 * when a client asks for any of them, we echo it back (per spec: "if the
 * server supports the requested version it MUST respond with the same
 * version"). This turns a future protocol bump from a forced client
 * disconnect into a no-op, without the kernel claiming behavior it doesn't
 * implement.
 */
export const SERVICEABLE_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

/** Echo the client's requested version when we can serve it; else our default. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    SERVICEABLE_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ResourceCapability {
  subscribe: boolean;
  listChanged: boolean;
}

export interface ToolCapability {
  /** Structurally false — the literal type, not a comment claiming one. The
   *  GRIMOIRE changes (that's `resources.listChanged`); the mouth does not, so
   *  `true` is not merely wrong here, it is unwritable. */
  listChanged: false;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { resources: ResourceCapability; tools: ToolCapability };
  serverInfo: ServerInfo;
}

/**
 * The subset of JSON Schema this server both ADVERTISES and ENFORCES.
 *
 * Deliberately narrow, and narrow as a TYPE rather than by convention: a
 * schema keyword `validateArguments` below cannot check is not representable
 * here, so the server can never advertise a constraint it does not apply. That
 * is the whole defect this shape exists to prevent — an `additionalProperties:
 * false` shown to every client while the handler read one property and ignored
 * the rest.
 */
export type ToolProperties = Record<
  string,
  { type: "string"; description?: string }
>;

export interface ToolInputSchema {
  type: "object";
  /** Every declared property is REQUIRED and is a string. There is no
   *  `required` list to keep in agreement with this one: an optional property
   *  would be advertised and then unenforceable (the validator can only check
   *  presence and type of what it iterates), and two lists that must agree by
   *  hand agree only until someone edits one. `properties` IS the required
   *  set — the wire's `required` array is derived from it at serialisation. */
  properties: ToolProperties;
  additionalProperties: false;
}

/**
 * A tool, INCLUDING what serves it.
 *
 * `serve` lives on the descriptor so the registry is a TOTAL map. Dispatch used
 * to be `tool === LIST_SPELLS_TOOL ? listSpells() : fetchSpell(args.spell)` — an
 * identity test with an else. A third entry added to `TOOLS` would have been
 * advertised by `tools/list`, validated against its own schema, and then routed
 * into `fetchSpell` with `args.spell === undefined`, compiling cleanly. The
 * comment above the registry claimed a tool "cannot be advertised-but-
 * undispatchable"; that held only while the cardinality was two.
 *
 * Generic over its own properties, so `serve` receives arguments typed by the
 * schema beside it — `args.spell` is checked against `properties.spell`, not
 * against `Record<string, string>` where any key type-checks.
 */
export interface ToolDescriptor<P extends ToolProperties = ToolProperties> {
  name: string;
  description: string;
  inputSchema: Omit<ToolInputSchema, "properties"> & { properties: P };
  serve: (
    handlers: McpHandlers,
    args: { [K in keyof P]: string },
  ) => Promise<ToolTextContent[]>;
}

/**
 * Declare a tool, INFERRING its property names into `serve`'s argument type.
 *
 * This exists because neither `const T: ToolDescriptor = {…}` nor
 * `{…} satisfies ToolDescriptor` binds the generic: both check against the
 * DEFAULT type argument, so `keyof P` widens to `string` and `serve` receives
 * the `Record<string, string>` the whole generic was added to avoid. A call
 * site is the only place TypeScript infers `P` from the literal — measured
 * both ways, twice, after the first fix silently did nothing.
 */
function defineTool<const P extends ToolProperties>(
  tool: ToolDescriptor<P>,
): ToolDescriptor<P> {
  return tool;
}

/**
 * The read verb, and it names its object.
 *
 * The name carries the promise on its own. A bare `fetch` would not: in this
 * ecosystem `fetch` means "fetch a URL", so it would import a capability this
 * kernel must never have. `fetch_spell` says what it retrieves, and the schema
 * closes the door behind the name — the sole property is `spell`, a short
 * name, with `additionalProperties: false`. Asking this tool for a URL has no
 * representation, rather than being validated away after the fact.
 *
 * The argument is `spell`, not `name`, because `tools/call` already carries a
 * `name` (the tool's own): `{"name": "fetch_spell", "arguments": {"name": …}}`
 * would use one word for two things in a single object.
 *
 * The description points at `list_spells` rather than naming a spell. Naming
 * one would put per-spell knowledge in a kernel that must not carry any — the
 * manifest is the catalog, and now the agent can read it.
 */
export const FETCH_SPELL_TOOL = defineTool({
  name: "fetch_spell",
  description:
    "Fetch one datamancy spell — a primer or ward — by its short name. Call " +
    "`list_spells` first to see the available names and what each spell does. " +
    "The body is the same verified markdown `resources/read` returns " +
    "(manifest signed, bytes hashed). This tool delivers the spell's text; it " +
    "does not cast it.",
  inputSchema: {
    type: "object",
    properties: {
      spell: {
        type: "string",
        description:
          'Short spell name, e.g. "grimoire". Not a URL or a path — the ' +
          "signed manifest is what resolves a name to its content.",
      },
    },
    additionalProperties: false,
  },
  serve: (handlers, args) => handlers.fetchSpell(args.spell),
});

/**
 * The catalog, through the tool mouth.
 *
 * The resources surface has always been list + read; the tool surface had only
 * read, and that asymmetry was the real gap. A tools-only host could be handed
 * a spell but could not discover which spells exist — so the entry point had to
 * be named in prose ("start with `grimoire`"), which baked one spell's NAME
 * into a kernel whose whole design is that the signed manifest is the only
 * catalog. Enumerating instead of instructing removes that hardcode.
 *
 * This is not a second catalog: the rows come from the same verified manifest
 * `resources/list` reads, on the same fetch-and-verify path. One catalog, two
 * mouths — exactly as `fetch_spell` is one pipeline with two mouths.
 */
export const LIST_SPELLS_TOOL = defineTool({
  name: "list_spells",
  description:
    "List every datamancy spell — primers and wards — with its short name " +
    "and what it does. Read from the live signed manifest, so it reflects the " +
    "grimoire as it is right now. Pass a name from this list to `fetch_spell` " +
    "to read that spell.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  serve: (handlers) => handlers.listSpells(),
});

/**
 * The tool registry — the ONE place the tool set is written down. `tools/list`,
 * the dispatch check, and the unknown-tool catalog all derive from it, so a
 * second tool cannot be advertised-but-undispatchable or missing from the miss
 * message. Three hand-written copies of "the tool set" agreed only while the
 * cardinality was 1.
 */
const TOOLS = [LIST_SPELLS_TOOL, FETCH_SPELL_TOOL] as const;

/** Any tool in the registry, each keeping its OWN property types. Declaring
 *  this `readonly ToolDescriptor[]` would widen every `serve` back to
 *  `Record<string, string>` and undo the inference at the declarations. */
type RegisteredTool = (typeof TOOLS)[number];

const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

function toolNamed(name: string): RegisteredTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** A tool as it goes on the wire: the descriptor, with `required` derived. */
export interface WireToolDescriptor
  extends Omit<ToolDescriptor, "inputSchema" | "serve"> {
  inputSchema: ToolInputSchema & { required: string[] };
}

export interface ListToolsResult {
  tools: readonly WireToolDescriptor[];
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface CallToolResult {
  content: ToolTextContent[];
  /** Set when the CALL failed in a way the agent can act on (a name that isn't
   *  in the grimoire). Per MCP, a tool-level failure is a result the model can
   *  read and retry from — not a JSON-RPC error, which is for protocol faults. */
  isError?: boolean;
}

export interface ResourceMeta {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface ListResourcesResult {
  resources: ResourceMeta[];
}

export interface ReadResourceParams {
  uri: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  /** UTF-8 text content (we only ship text resources). */
  text?: string;
}

/**
 * The one wording for "these bytes are not what the origin just served".
 *
 * Shared by BOTH mouths. It lived only on the tool path, which is how
 * `resources/read` came to return stale content with no marker at all — the
 * loud log announcing it goes to stderr, and neither a model nor most hosts
 * read that.
 */
export const STALE_NOTICE =
  "NOTE: the origin could not be verified on this read. What follows is the " +
  "last copy that did verify.";

export interface ReadResourceResult {
  contents: ResourceContent[];
}

/**
 * Check a `tools/call` argument object against the tool's OWN advertised
 * schema. The schema the client is shown and the check the server runs are the
 * same object, so they cannot drift — and because `ToolInputSchema` can only
 * express what this function enforces, the pair is complete by construction.
 *
 * Returns the validated arguments. Throws BadArgumentsError naming the specific
 * miss — an unknown key is refused rather than silently ignored, which is what
 * `additionalProperties: false` has always claimed on the wire.
 */
export function validateArguments(
  // Only what it reads: the name for the message, and the properties it checks
  // against. Taking a whole `ToolDescriptor` would drag `serve` in, and `serve`
  // is contravariant in its argument type — so a descriptor with real property
  // names would not be assignable to the widened one, purely because of a field
  // this function never touches.
  tool: { name: string; inputSchema: { properties: ToolProperties } },
  rawArguments: unknown,
): Record<string, string> {
  const schema = tool.inputSchema;
  if (
    typeof rawArguments !== "object" ||
    rawArguments === null ||
    Array.isArray(rawArguments)
  ) {
    const first = Object.keys(schema.properties)[0];
    throw new BadArgumentsError(
      `${tool.name} requires an "arguments" object` +
        (first
          ? `, e.g. {"${first}": "grimoire"}.`
          : ` (an empty one, {}, is fine — this tool takes no arguments).`),
    );
  }
  const args = rawArguments as Record<string, unknown>;

  const unknown = Object.keys(args).filter(
    (k) => !Object.prototype.hasOwnProperty.call(schema.properties, k),
  );
  if (unknown.length > 0) {
    throw new BadArgumentsError(
      `${tool.name} does not accept ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
        `It accepts exactly: ${Object.keys(schema.properties).join(", ") || "(no arguments)"}. ` +
        `A spell is addressed by its short name; these tools never take a URL ` +
        `or a path.`,
    );
  }

  const out: Record<string, string> = {};
  for (const key of Object.keys(schema.properties)) {
    const value = args[key];
    if (typeof value !== "string") {
      throw new BadArgumentsError(
        `${tool.name} requires arguments.${key} (string) — the short spell ` +
          `name, e.g. {"${key}": "grimoire"}. Call list_spells for the names.`,
      );
    }
    out[key] = value;
  }
  return out;
}

export interface McpHandlers {
  serverInfo: ServerInfo;
  listResources: () => Promise<ListResourcesResult>;
  readResource: (params: ReadResourceParams) => Promise<ReadResourceResult>;
  /**
   * The catalog, rendered for a model — what `list_spells` calls. Same verified
   * manifest rows `listResources` returns.
   *
   * Returns the CONTENT BLOCKS, not text plus a provenance label. A label
   * beside the payload is a label a caller can drop, and one did: the tool
   * mouth disclosed a last-known-good body while `resources/read` returned the
   * same stale bytes unmarked. Moving the disclosure into the payload the two
   * tool mouths share removes it from THIS boundary. It is not gone from the
   * codebase — the resource mouth and the catalog descriptions each assemble
   * their own notice in handlers.ts, and `ToolTextContent[]` cannot express
   * "notice first when stale". Three sites, one convention.
   */
  listSpells: () => Promise<ToolTextContent[]>;
  /**
   * Deliver one spell by short name — what `fetch_spell` calls. Blocks, for the
   * same reason as above: the spell's own block stays byte-identical to what
   * `resources/read` returns, and a staleness notice rides beside it rather
   * than in a field someone can ignore.
   *
   * Both are required, not optional: an implementation that satisfies the
   * resources surface while leaving tools-only hosts with nothing is exactly
   * the gap this version closes, so the wrong shape is uncompilable.
   */
  fetchSpell: (spell: string) => Promise<ToolTextContent[]>;
}

/**
 * Build a stdio MCP server. The caller wires up the actual datamancy
 * logic (manifest fetch, signature verify, hash check) inside the
 * handlers; this function only knows about the protocol.
 */
export function createMcpServer(handlers: McpHandlers): StdioServer {
  const server = new StdioServer();

  server.onRequest("initialize", async (rawParams) => {
    // Echo the client's requested protocol version when it's one we can serve
    // identically (the resources capability is unchanged across them); else
    // respond with our default. Both branches are spec-compliant.
    const requested = (rawParams as { protocolVersion?: unknown } | null)
      ?.protocolVersion;
    const result: InitializeResult = {
      protocolVersion: negotiateProtocolVersion(requested),
      capabilities: {
        resources: {
          subscribe: false,
          // Live mode emits notifications/resources/list_changed when a cast
          // reveals the spell SET changed (a spell added/removed), nudging a
          // long-lived session to re-source the grimoire. Reactive, not
          // polled — detected on the read that's already fetching the manifest.
          listChanged: true,
        },
        // Advertised so a spec-following client is ALLOWED to call tools/list
        // (and a spec-breaking one no longer gets -32601 and calls us dead).
        // The mouth cannot change within a RUNNING PROCESS: the registry is a
        // module constant, so a new tool arrives only with a package upgrade,
        // which is a restart and a fresh `initialize`. That — not permanence —
        // is what `listChanged: false` promises the client. (MUST NEVER 11
        // freezes the existing names and argument shapes; it does not forbid
        // the list growing, and it did grow in 1.1.0, from zero tools to two.)
        tools: { listChanged: false },
      },
      serverInfo: handlers.serverInfo,
    };
    return result;
  });

  server.onNotification("notifications/initialized", async () => {
    // Client confirms initialization complete. No response — by spec.
  });

  // (No notifications/cancelled handler: unhandled notifications are silently
  // ignored by the protocol layer, which is the correct behavior — reads are
  // sub-second, so there is nothing in flight worth aborting.)

  server.onRequest("ping", async () => {
    return {};
  });

  server.onRequest("resources/list", async () => {
    return await handlers.listResources();
  });

  server.onRequest("resources/read", async (rawParams) => {
    if (
      typeof rawParams !== "object" ||
      rawParams === null ||
      typeof (rawParams as { uri?: unknown }).uri !== "string"
    ) {
      throw new BadParamsError("resources/read requires params.uri (string)");
    }
    return await handlers.readResource(rawParams as ReadResourceParams);
  });

  server.onRequest("tools/list", async () => {
    // `required` is DERIVED here, at the one place the schema goes on the wire,
    // so what a client is shown and what the server enforces are the same list
    // by construction rather than by agreement.
    const result: ListToolsResult = {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: {
          ...inputSchema,
          required: Object.keys(inputSchema.properties),
        },
      })),
    };
    return result;
  });

  server.onRequest("tools/call", async (rawParams) => {
    const p = (rawParams ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof p.name !== "string") {
      throw new BadParamsError("tools/call requires params.name (string)");
    }
    // A tool we never listed is a PROTOCOL fault — the client asked for
    // something no handshake offered — so it surfaces as a JSON-RPC error, not
    // as tool output the model would try to reason its way out of. Both the
    // check and the catalog in the message come from the registry, so they
    // cannot disagree with what tools/list advertised.
    const tool = toolNamed(p.name);
    if (!tool) {
      throw new UnknownToolError(p.name, [...TOOL_NAMES]);
    }
    try {
      // Inside the try so every failure from this call leaves through one
      // catch. Note this is NOT currently load-bearing: BadArgumentsError is
      // `operator` audience (errors.ts explains why — the MCP spec files
      // invalid arguments under protocol errors), so it takes the rethrow
      // branch from either position. It matters only if that spec position
      // moves; keeping the call inside means the routing would follow.
      const args = validateArguments(tool, p.arguments ?? {});
      // The ONE place the validated arguments meet the descriptor's own
      // parameter type. `validateArguments` guarantees every declared property
      // is present and a string — which IS `serve`'s parameter — but the two
      // meet through a string-keyed record, so the connection is asserted here
      // rather than inferred. Everything upstream of this line is inferred:
      // `defineTool` binds each tool's property names into its own `serve`, so
      // a body reading a key its schema does not declare fails to compile.
      const serve = tool.serve as (
        handlers: McpHandlers,
        args: Record<string, string>,
      ) => Promise<ToolTextContent[]>;
      const content = await serve(handlers, args);
      const result: CallToolResult = { content };
      return result;
    } catch (err) {
      // A failure the MODEL can act on — a name that isn't in the grimoire,
      // whose recovery (the catalog) is in the message — comes back as tool
      // output it can read and retry from. Everything else (a bad signature, a
      // hash mismatch, an unreachable origin) stays a thrown JSON-RPC error: a
      // refusal must never be mistakable for a body.
      //
      // Routed on the error's DECLARED audience, not on its class. An
      // instanceof list here would be the hand-maintained allow-list the error
      // hierarchy exists to prevent, and the next recoverable variant would
      // silently take the wrong branch.
      if (isModelAudience(err)) {
        const result: CallToolResult = {
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        };
        return result;
      }
      throw err;
    }
  });

  return server;
}
