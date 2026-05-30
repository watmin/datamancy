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
 * We expose only the `resources` capability — listing and reading. No
 * tools, no prompts, no sampling, no subscriptions. Datamancy spells are
 * static markdown, hash-verified (and UTF-8-checked) at read time.
 *
 * The full MCP spec includes many more methods; we ignore everything we
 * don't implement and the protocol layer returns MethodNotFound for any
 * unsupported method. Clients are expected to discover capabilities via
 * the `initialize` handshake and degrade gracefully.
 */

import { StdioServer } from "./protocol.js";
import { BadParamsError } from "./errors.js";

/**
 * Default protocol version — what we offer when the client's requested version
 * isn't one we recognize (a spec-compliant "respond with a version we support").
 */
export const SUPPORTED_PROTOCOL_VERSION = "2024-11-05";

/**
 * Protocol versions this server can serve identically. We expose only the
 * `resources` capability (list + read + listChanged), whose shape is unchanged
 * across these MCP revisions — so when a client asks for any of them, we echo
 * it back (per spec: "if the server supports the requested version it MUST
 * respond with the same version"). This turns a future protocol bump from a
 * forced client disconnect into a no-op, without the frozen kernel claiming
 * behavior it doesn't implement.
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
    : SUPPORTED_PROTOCOL_VERSION;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ResourceCapability {
  subscribe: boolean;
  listChanged: boolean;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { resources: ResourceCapability };
  serverInfo: ServerInfo;
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

export interface ReadResourceResult {
  contents: ResourceContent[];
}

export interface McpHandlers {
  serverInfo: ServerInfo;
  listResources: () => Promise<ListResourcesResult>;
  readResource: (params: ReadResourceParams) => Promise<ReadResourceResult>;
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

  return server;
}
