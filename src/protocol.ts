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
 * (result OR error, never both). A handler exception becomes an error response
 * carrying the code the thrown value declares (see CodedError) — InternalError
 * only when it declares none. Parse failures become error responses with
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

/**
 * A handler error MAY declare the JSON-RPC code it should surface as.
 *
 * Declared here, in the framing layer that owns the wire, and satisfied
 * structurally by whatever the handlers throw — so this layer never learns
 * which error classes exist. Without it every throw flattened to
 * InternalError, telling a client "the server broke" for what was its own
 * malformed request; JSON-RPC 2.0 §5.1 reserves -32603 for a genuine
 * server-side fault, and the MCP spec's worked example for an unknown tool is
 * -32602.
 */
export interface CodedError {
  /** Not `number`: only a code this layer actually defines. `42` is not a
   *  JSON-RPC error code and should not type-check as one. */
  readonly rpcCode: (typeof ErrorCodes)[keyof typeof ErrorCodes];
}

/** The code a thrown value asks for, else InternalError. A value that declares
 *  nothing is, by definition, an internal fault. */
function codeOf(err: unknown): number {
  const declared = (err as Partial<CodedError> | null | undefined)?.rpcCode;
  return typeof declared === "number" && Number.isInteger(declared)
    ? declared
    : ErrorCodes.InternalError;
}

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

  /** Server-initiated notification (no id, no response expected).
   *
   *  No params: the only notification this server emits carries none, and an
   *  optional parameter no caller ever supplies is a signature promising a
   *  variation that does not exist. */
  sendNotification(method: string): void {
    this.out.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
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

    // A JSON-RPC BATCH — an array of requests and/or notifications. MCP
    // 2025-03-26 permits one on the stdio transport, and this server echoes
    // that version back to any client that asks for it, so it must accept one:
    // rejecting the array answered a two-request batch with a single
    // InvalidRequest and left BOTH ids unanswered, hanging the client until its
    // own timeout. (2024-11-05 never had batches and 2025-06-18 removed them
    // again; accepting one on those revisions costs nothing, because a client
    // that never sends one never reaches this branch.)
    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        this.sendError(null, ErrorCodes.InvalidRequest, "Invalid Request");
        return;
      }
      const responses = (
        await Promise.all(msg.map((m) => this.dispatch(m)))
      ).filter((r): r is JsonRpcResult | JsonRpcErrorResponse => r !== null);
      // An all-notification batch expects no reply at all — by spec, and
      // writing an empty array instead would be a message the client must
      // then decide how to ignore.
      if (responses.length > 0) {
        this.out.write(JSON.stringify(responses) + "\n");
      }
      return;
    }

    const response = await this.dispatch(msg);
    if (response) this.writeMessage(response);
  }

  /**
   * Turn ONE parsed message into its response, or null when it demands none (a
   * notification). Returning the response rather than writing it is what lets a
   * batch collect several into one array — and it keeps single and batched
   * messages on the identical code path, so the two can never disagree about
   * what a given message means.
   */
  private async dispatch(
    msg: unknown,
  ): Promise<JsonRpcResult | JsonRpcErrorResponse | null> {
    if (!isRequest(msg)) {
      const id = (msg as { id?: JsonRpcId } | null)?.id ?? null;
      return this.errorMessage(id, ErrorCodes.InvalidRequest, "Invalid Request");
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
      return null;
    }

    // Request path: dispatch, produce exactly one response. id may be null
    // here (a valid id) — echo it back as-is.
    const id: JsonRpcId = msg.id ?? null;
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      return this.errorMessage(
        id,
        ErrorCodes.MethodNotFound,
        `Method not found: ${msg.method}`,
      );
    }

    try {
      return { jsonrpc: "2.0", id, result: await handler(msg.params) };
    } catch (err) {
      return this.errorMessage(
        id,
        codeOf(err),
        err instanceof Error ? err.message : String(err),
        // The error's NAME, never its stack. A stack is Node's default shape
        // for an Error and nobody chose to put it on this channel — it carries
        // the absolute install path, which under `npx` is
        // /home/<user>/.npm/_npx/<hash>/…, onto a wire MCP hosts routinely
        // surface into model context. The operator's copy still goes to stderr,
        // which is the audience a stack is for.
        err instanceof Error ? { name: err.name } : undefined,
      );
    }
  }

  private errorMessage(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcErrorResponse {
    const body: JsonRpcErrorBody = { code, message };
    if (data !== undefined) body.data = data;
    return { jsonrpc: "2.0", id, error: body };
  }

  private writeMessage(msg: JsonRpcResult | JsonRpcErrorResponse): void {
    this.out.write(JSON.stringify(msg) + "\n");
  }

  private sendError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.writeMessage(this.errorMessage(id, code, message, data));
  }
}

function isRequest(x: unknown): x is JsonRpcRequest {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") return false;
  if (typeof r.method !== "string") return false;
  return true;
}
