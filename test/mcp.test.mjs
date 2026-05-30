// The MCP handler layer: the initialize handshake (protocol-version echo —
// the fix that keeps a future client from disconnecting), the advertised
// capability shape, ping, and resources/read param validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServer,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSION,
  SERVICEABLE_PROTOCOL_VERSIONS,
} from "../dist/mcp.js";
import { captureStdout } from "./helpers.mjs";

function mcp() {
  return createMcpServer({
    serverInfo: { name: "datamancy", version: "1.0.0" },
    listResources: async () => ({ resources: [] }),
    readResource: async ({ uri }) => ({
      contents: [{ uri, mimeType: "text/markdown", text: "ok" }],
    }),
  });
}

async function call(method, params, id = 1) {
  const s = mcp();
  const out = await captureStdout(async () => {
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  return JSON.parse(out[0]);
}

test("negotiateProtocolVersion ECHOES a serviceable requested version", () => {
  for (const v of SERVICEABLE_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(v), v);
  }
});

test("negotiateProtocolVersion falls back to the default for an unknown/garbage request", () => {
  assert.equal(negotiateProtocolVersion("3025-01-01"), SUPPORTED_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(42), SUPPORTED_PROTOCOL_VERSION);
});

test("initialize echoes a NEWER serviceable version the client requested", async () => {
  const r = await call("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(r.result.protocolVersion, "2025-06-18");
});

test("initialize offers the default when the client requests an unknown version", async () => {
  const r = await call("initialize", { protocolVersion: "3025-01-01" });
  assert.equal(r.result.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
});

test("initialize advertises resources with listChanged, no subscribe", async () => {
  const r = await call("initialize", {});
  assert.deepEqual(r.result.capabilities.resources, {
    subscribe: false,
    listChanged: true,
  });
  assert.equal(r.result.serverInfo.name, "datamancy");
});

test("ping → empty result", async () => {
  const r = await call("ping", {});
  assert.deepEqual(r.result, {});
});

test("resources/read WITHOUT a uri → BadParams (InternalError envelope)", async () => {
  const r = await call("resources/read", {});
  assert.match(r.error.message, /requires params\.uri/);
});

test("resources/read with a NON-STRING uri is rejected (no unvalidated value reaches fetch)", async () => {
  const r = await call("resources/read", { uri: 123 });
  assert.match(r.error.message, /requires params\.uri/);
});

test("resources/read with a string uri reaches the handler", async () => {
  const r = await call("resources/read", { uri: "spell://x" });
  assert.equal(r.result.contents[0].text, "ok");
});
