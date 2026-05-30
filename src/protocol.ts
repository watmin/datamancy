/**
 * JSON-RPC 2.0 over newline-delimited JSON on stdio.
 *
 * Zero dependencies. Every line in / every line out. Each line is a
 * complete JSON-RPC message (request, notification, or response).
 *
 * Reference: https://www.jsonrpc.org/specification
 *
 * We implement only the server side: receive requests and notifications
 * on stdin, dispatch to registered handlers, write responses to stdout.
 * Notifications expect no response. Requests expect exactly one response
 * (result OR error, never both). Handler exceptions become error responses
 * with code = InternalError. Parse failures become error responses with
 * id = null and code = ParseError.
 */

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Present for requests, absent for notifications. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResult {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => Promise<void>;

export class StdioServer {
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private readonly out: NodeJS.WritableStream = stdout;

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Server-initiated notification (no id, no response expected). */
  sendNotification(method: string, params?: unknown): void {
    this.out.write(
      JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n",
    );
  }

  /**
   * Begin reading JSON-RPC lines from stdin. Resolves only when stdin closes.
   * Errors during message handling are logged to stderr but do not stop the
   * loop — a bad message must not take down the server.
   */
  async listen(): Promise<void> {
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      // Dispatch each line independently. We don't await to allow
      // concurrent in-flight requests; handlers themselves are async
      // and their responses are written when ready.
      this.handleLine(line).catch((err) => {
        process.stderr.write(
          `[protocol] dispatch error: ${err instanceof Error ? err.message : err}\n`,
        );
      });
    }
  }

  /** Visible for testing. */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(null, ErrorCodes.ParseError, "Parse error");
      return;
    }

    if (!isRequest(msg)) {
      const id = (msg as { id?: JsonRpcId } | null)?.id ?? null;
      this.sendError(id, ErrorCodes.InvalidRequest, "Invalid Request");
      return;
    }

    // Notification path: a notification is a request object WITHOUT an `id`
    // member (JSON-RPC 2.0 §4.1). `id: null` is a VALID request id, not a
    // notification — it still demands exactly one response, or a client that
    // sent it deadlocks forever. So key off ABSENCE of id, never `=== null`.
    if (!("id" in msg)) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        try {
          await handler(msg.params);
        } catch (err) {
          process.stderr.write(
            `[protocol] notification "${msg.method}" failed: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }
      return;
    }

    // Request path: dispatch, send exactly one response. id may be null here
    // (a valid id) — echo it back as-is.
    const id: JsonRpcId = msg.id ?? null;
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      this.sendError(
        id,
        ErrorCodes.MethodNotFound,
        `Method not found: ${msg.method}`,
      );
      return;
    }

    try {
      const result = await handler(msg.params);
      this.sendResult(id, result);
    } catch (err) {
      this.sendError(
        id,
        ErrorCodes.InternalError,
        err instanceof Error ? err.message : String(err),
        err instanceof Error
          ? { name: err.name, stack: err.stack }
          : undefined,
      );
    }
  }

  private writeMessage(msg: JsonRpcResult | JsonRpcErrorResponse): void {
    this.out.write(JSON.stringify(msg) + "\n");
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private sendError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const body: JsonRpcErrorBody = { code, message };
    if (data !== undefined) body.data = data;
    this.writeMessage({ jsonrpc: "2.0", id, error: body });
  }
}

function isRequest(x: unknown): x is JsonRpcRequest {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") return false;
  if (typeof r.method !== "string") return false;
  return true;
}
