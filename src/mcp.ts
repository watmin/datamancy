/**
 * MCP (Model Context Protocol) handlers on top of the JSON-RPC stdio
 * framing in protocol.ts.
 *
 * Spec: https://modelcontextprotocol.io
 * Protocol version we negotiate: 2024-11-05 (a known stable version).
 *
 * We expose only the `resources` capability — listing and reading. No
 * tools, no prompts, no sampling, no subscriptions. Datamancy spells are
 * static markdown, hash-verified at read time.
 *
 * The full MCP spec includes many more methods; we ignore everything we
 * don't implement and the protocol layer returns MethodNotFound for any
 * unsupported method. Clients are expected to discover capabilities via
 * the `initialize` handshake and degrade gracefully.
 */

import { StdioServer } from "./protocol.js";
import { BadParamsError } from "./errors.js";

/** Protocol version we negotiate against clients. */
export const SUPPORTED_PROTOCOL_VERSION = "2024-11-05";

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
    // We accept the client's protocol version request but always
    // negotiate to OUR supported version in the response. Clients are
    // expected to handle version mismatch by either accepting or
    // disconnecting.
    void rawParams; // input acknowledged; specific fields not used here
    const result: InitializeResult = {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
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
