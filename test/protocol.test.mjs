// JSON-RPC dispatch survival. The single entry point for every client message:
// a bad message must never take down the server, and the JSON-RPC contract
// (one response per request, ZERO per notification) must hold exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StdioServer, ErrorCodes } from "../dist/protocol.js";
import { captureStdout } from "./helpers.mjs";

function server() {
  const s = new StdioServer();
  s.onRequest("ok", async () => ({ ok: true }));
  s.onRequest("boom", async () => {
    throw new Error("kaboom");
  });
  s.onRequest("boomString", async () => {
    throw "raw string"; // a non-Error throw must still become a clean response
  });
  s.onNotification("note", async () => {
    /* no response by contract */
  });
  s.onNotification("noteThrows", async () => {
    throw new Error("notification handler failed");
  });
  return s;
}

/** Drive lines through one server, return parsed JSON responses. */
async function drive(lines) {
  const s = server();
  const out = await captureStdout(async () => {
    for (const line of lines) await s.handleLine(line);
  });
  return out.map((l) => JSON.parse(l));
}

test("malformed JSON → ParseError with id null", async () => {
  const [r] = await drive(["{not json"]);
  assert.equal(r.error.code, ErrorCodes.ParseError);
  assert.equal(r.id, null);
});

test("non-2.0 / shapeless message → InvalidRequest, id echoed", async () => {
  const [r] = await drive([JSON.stringify({ jsonrpc: "1.0", id: 7 })]);
  assert.equal(r.error.code, ErrorCodes.InvalidRequest);
  assert.equal(r.id, 7);
});

test("unknown method → MethodNotFound", async () => {
  const [r] = await drive([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }),
  ]);
  assert.equal(r.error.code, ErrorCodes.MethodNotFound);
});

test("a known request → exactly one result, id echoed", async () => {
  const out = await drive([
    JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "ok" }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].result, { ok: true });
  assert.equal(out[0].id, "abc");
});

test("a handler that throws → InternalError, message surfaced, server survives", async () => {
  const [r] = await drive([
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "boom" }),
  ]);
  assert.equal(r.error.code, ErrorCodes.InternalError);
  assert.match(r.error.message, /kaboom/);
});

test("a NON-Error throw is still a clean InternalError (no crash)", async () => {
  const [r] = await drive([
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "boomString" }),
  ]);
  assert.equal(r.error.code, ErrorCodes.InternalError);
});

test("NOTIFICATIONS produce no response — even when the handler throws", async () => {
  // 4 inputs: a notification, a blank line, an unknown notification, and a
  // throwing notification → all must emit ZERO bytes on stdout.
  const out = await drive([
    JSON.stringify({ jsonrpc: "2.0", method: "note" }),
    "   ",
    JSON.stringify({ jsonrpc: "2.0", method: "unknownNote" }),
    JSON.stringify({ jsonrpc: "2.0", method: "noteThrows" }),
  ]);
  assert.equal(out.length, 0);
});

test("a batch of garbage interleaved with one good request: the good one still answers", async () => {
  const out = await drive([
    "garbage",
    JSON.stringify({ jsonrpc: "2.0", method: "note" }),
    JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ok" }),
    JSON.stringify({ jsonrpc: "2.0", id: 10, method: "missing" }),
  ]);
  // parse-error(1) + ok-result(1) + method-not-found(1) = 3; notification = 0
  assert.equal(out.length, 3);
  const ok = out.find((m) => m.id === 9);
  assert.deepEqual(ok.result, { ok: true });
});

test("a 5 MB line does not crash the dispatcher", async () => {
  const big = "x".repeat(5 * 1024 * 1024);
  const out = await drive([big]);
  assert.equal(out[0].error.code, ErrorCodes.ParseError);
});
