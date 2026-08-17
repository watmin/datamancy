// The TOOL surface — `list_spells` and `fetch_spell`, for hosts that only wire
// tools through to the agent. What this file pins:
//
//   * tools/list is never -32601, and holds exactly the registry;
//   * the tool mouths return the SAME verified bytes the resource mouths do,
//     through the same pipeline (no second fetch path, no per-spell branch);
//   * a name that isn't in the grimoire comes back as agent-readable tool
//     output carrying the catalog — never a body, and never eating the
//     list_changed nudge;
//   * a VERIFICATION failure with nothing known-good REFUSES, loudly, as a
//     JSON-RPC error, and a last-known-good body is LABELLED as one;
//   * client faults carry -32602, not -32603.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServer,
  FETCH_SPELL_TOOL,
  LIST_SPELLS_TOOL,
  validateArguments,
} from "../dist/mcp.js";
import { createGrimoireHandlers } from "../dist/handlers.js";
import { Grimoire } from "../dist/grimoire.js";
import { UnknownSpellError } from "../dist/errors.js";
import {
  publicKey,
  signBytes,
  bytesOf,
  resourceFor,
  bodyOf,
  manifestFor,
  installFetch,
  captureStdout,
} from "./helpers.mjs";

const SITE = "https://test.invalid";
const noop = () => {};

const GRIMOIRE_BODY = "# grimoire\nSTART HERE — the index.";
const INTUERI_BODY = "# intueri\nContemplate whether the code speaks.";

// ── Layer 1: an origin ───────────────────────────────────────────────────────

/** Install a signed origin serving `resources`, with `bodies` overriding what
 *  each spell's URL returns (to forge a tamper). Returns the restore fn.
 *
 *  The DEFAULT is the body the row's sha256 was computed over — so an origin
 *  built from rows alone verifies. It used to default to a `# ${name}`
 *  placeholder that matched no hash, which made the un-overridden path a silent
 *  tamper wearing the word "serving"; the next test to read a second spell from
 *  such an origin would have failed as "verification broke" rather than "the
 *  fixture served the wrong bytes". A row with no recorded body and no override
 *  now throws here rather than being quietly forged. */
function serveOrigin(resources, bodies = {}, extra = {}) {
  const manifestBytes = bytesOf(manifestFor(resources, extra));
  const sig = signBytes(manifestBytes);
  const served = Object.fromEntries(
    resources.map((r) => {
      const body = bodies[r.name] ?? bodyOf(r);
      if (body === undefined) {
        throw new Error(
          `serveOrigin: no body for "${r.name}" — pass one in \`bodies\`, or build ` +
            `the row with resourceFor so its content is recoverable. Serving a ` +
            `placeholder would forge a tamper the test did not ask for.`,
        );
      }
      return [r.name, body];
    }),
  );
  return installFetch((url) => {
    if (url.endsWith("/manifest.json")) return manifestBytes;
    if (url.endsWith("/manifest.json.sig")) return sig;
    return served[url.split("/").at(-2)] ?? null;
  });
}

/** The two-spell grimoire most tests run against. */
const TWO_SPELLS = () => [
  resourceFor("grimoire", GRIMOIRE_BODY),
  resourceFor("intueri", INTUERI_BODY),
];

/** A live-mode Grimoire over a freshly installed two-spell origin. */
function serveGrimoire({ bodies = {}, log = noop, resources = TWO_SPELLS() } = {}) {
  const restore = serveOrigin(resources, {
    grimoire: GRIMOIRE_BODY,
    intueri: INTUERI_BODY,
    ...bodies,
  });
  return { grimoire: new Grimoire({ site: SITE, verifyKey: publicKey }, log), restore };
}

// ── Layer 2: handlers over a grimoire ────────────────────────────────────────

/** Handlers over a real (hermetic) Grimoire, plus the notifications it emits. */
function handlersOver(grimoire, log = noop) {
  const notified = [];
  const handlers = createGrimoireHandlers(
    grimoire,
    { name: "datamancy", version: "1.1.0" },
    (m) => notified.push(m),
    log,
  );
  return { handlers, notified };
}

/** Handlers with no grimoire behind them — enough to exercise the protocol.
 *  Implements the FULL McpHandlers shape; a partial one is not a server. */
function stubHandlers() {
  return {
    serverInfo: { name: "datamancy", version: "1.1.0" },
    listResources: async () => ({ resources: [] }),
    readResource: async ({ uri }) => ({
      contents: [{ uri, mimeType: "text/markdown", text: "ok" }],
    }),
    listSpells: async () => [{ type: "text", text: "stub — a\nstub — b" }],
    fetchSpell: async () => [{ type: "text", text: "stub body" }],
  };
}

// ── Layer 3: the wire ────────────────────────────────────────────────────────

/** Drive one JSON-RPC line and return the response carrying OUR id.
 *
 *  Never "the first line": a server-initiated notification is written before
 *  the handler's result whenever a read surfaces a spell-set change, so
 *  out[0] is the notification and `r.result` would be undefined. */
async function rpc(handlers, method, params, id = 1) {
  const server = createMcpServer(handlers);
  const lines = await captureStdout(async () => {
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const messages = lines.map((l) => JSON.parse(l));
  const response = messages.find((m) => m.id === id);
  assert.ok(response, `no response for id ${id}: ${JSON.stringify(messages)}`);
  return response;
}

let restoreFetch = null;
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

// ── The catalog a tools-only host sees ──────────────────────────────────────

test("tools/list is NOT -32601 — the whole reason 1.1.0 exists", async () => {
  const r = await rpc(stubHandlers(), "tools/list", {});
  assert.equal(r.error, undefined, "tools/list must not error");
  assert.deepEqual(
    r.result.tools.map((t) => t.name),
    ["list_spells", "fetch_spell"],
  );
});

test("initialize advertises tools ALONGSIDE resources (resources are not dropped)", async () => {
  const r = await rpc(stubHandlers(), "initialize", {});
  assert.deepEqual(r.result.capabilities.tools, { listChanged: false });
  assert.deepEqual(r.result.capabilities.resources, {
    subscribe: false,
    listChanged: true,
  });
});

test("the tool pair is discoverable end-to-end: list names it, fetch takes it", async () => {
  // A tools-only agent's whole path: it can enumerate, then read. Neither
  // description names a specific spell — the manifest is the catalog.
  assert.match(LIST_SPELLS_TOOL.description, /list/i);
  assert.match(FETCH_SPELL_TOOL.description, /list_spells/);
  assert.deepEqual(Object.keys(FETCH_SPELL_TOOL.inputSchema.properties), ["spell"]);
  assert.deepEqual(Object.keys(LIST_SPELLS_TOOL.inputSchema.properties), []);
  for (const tool of [LIST_SPELLS_TOOL, FETCH_SPELL_TOOL]) {
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("the wire schema DERIVES required from properties — they cannot disagree", async () => {
  // Previously two hand-kept lists. A property advertised but not required was
  // accepted with any value type and silently discarded — the server showing a
  // constraint it did not apply.
  const r = await rpc(stubHandlers(), "tools/list", {});
  for (const tool of r.result.tools) {
    assert.deepEqual(
      tool.inputSchema.required,
      Object.keys(tool.inputSchema.properties),
      `${tool.name}: required must equal the declared properties`,
    );
  }
  const fetchTool = r.result.tools.find((t) => t.name === "fetch_spell");
  assert.deepEqual(fetchTool.inputSchema.required, ["spell"]);
});

test("no spell NAME is baked into the kernel — renaming the index cannot strand a client", async () => {
  // The kernel carries zero per-spell knowledge. A hardcoded entry point would
  // be an unwritten, permanent obligation on the website.
  const kernelText = [
    LIST_SPELLS_TOOL.description,
    FETCH_SPELL_TOOL.description,
    FETCH_SPELL_TOOL.inputSchema.properties.spell.description,
    new UnknownSpellError("x", ["a", "b"]).message,
  ].join(" ");
  assert.doesNotMatch(kernelText, /\bStart with\b/i);
  assert.doesNotMatch(kernelText, /`grimoire`/);
});

// ── Arguments are checked against the ADVERTISED schema ─────────────────────

test("a URL alongside a VALID spell is REFUSED — additionalProperties is enforced, not decorative", async () => {
  // The property the schema advertises. Sending `spell` correctly AND an extra
  // `uri` is the case that matters: omitting `spell` would only prove the
  // missing-argument branch, which is a different check entirely.
  const r = await rpc(stubHandlers(), "tools/call", {
    name: "fetch_spell",
    arguments: { spell: "grimoire", uri: "https://evil.invalid/x" },
  });
  assert.equal(r.result, undefined, "must not return a body");
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /does not accept "uri"/);
});

test("the validator IS the advertised schema — they cannot drift", () => {
  // Driven off the tool's own inputSchema, so a schema change moves the check.
  assert.deepEqual(validateArguments(FETCH_SPELL_TOOL, { spell: "x" }), {
    spell: "x",
  });
  assert.throws(() => validateArguments(FETCH_SPELL_TOOL, { spell: 42 }), /requires arguments\.spell/);
  assert.throws(() => validateArguments(FETCH_SPELL_TOOL, { nope: "x" }), /does not accept "nope"/);
  assert.deepEqual(validateArguments(LIST_SPELLS_TOOL, {}), {});
  assert.throws(() => validateArguments(LIST_SPELLS_TOOL, { spell: "x" }), /does not accept "spell"/);
});

test("client faults carry -32602, not -32603 — a bad request is not a server fault", async () => {
  const unknownTool = await rpc(stubHandlers(), "tools/call", {
    name: "cast",
    arguments: {},
  });
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /Unknown tool: "cast"/);
  assert.match(unknownTool.error.message, /list_spells/);
  assert.match(unknownTool.error.message, /fetch_spell/);

  const noArgs = await rpc(stubHandlers(), "tools/call", { name: "fetch_spell" });
  assert.equal(noArgs.error.code, -32602);

  const noName = await rpc(stubHandlers(), "tools/call", {});
  assert.equal(noName.error.code, -32602);
});

test("no error response carries a stack trace onto the wire", async () => {
  // A stack leaks the absolute install path — under npx, the OS username — onto
  // a channel MCP hosts surface into model context.
  const r = await rpc(stubHandlers(), "tools/call", { name: "cast", arguments: {} });
  assert.deepEqual(Object.keys(r.error.data ?? {}), ["name"]);
});

// ── Calling them ────────────────────────────────────────────────────────────

test("list_spells returns the live catalog, one row per spell", async () => {
  const { grimoire, restore } = serveGrimoire();
  restoreFetch = restore;
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);
  const r = await rpc(handlers, "tools/call", { name: "list_spells", arguments: {} });
  const rows = r.result.content[0].text.split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^grimoire — /);
  assert.match(rows[1], /^intueri — /);
});

test("tools/call fetch_spell returns the spell as text content", async () => {
  const { grimoire, restore } = serveGrimoire();
  restoreFetch = restore;
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);
  const r = await rpc(handlers, "tools/call", {
    name: "fetch_spell",
    arguments: { spell: "grimoire" },
  });
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(r.result.content, [{ type: "text", text: GRIMOIRE_BODY }]);
});

test("fetch_spell returns BYTE-IDENTICAL text to resources/read for the same spell", async () => {
  const { grimoire, restore } = serveGrimoire();
  restoreFetch = restore;
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);

  const viaTool = await handlers.fetchSpell("intueri");
  const { resources } = await handlers.listResources();
  const uri = resources.find((r) => r.name === "intueri").uri;
  const viaResource = await handlers.readResource({ uri });

  assert.equal(viaTool.length, 1, "verified content carries no notice block");
  assert.equal(viaResource.contents.length, 1);
  assert.equal(viaTool[0].text, viaResource.contents[0].text);
  assert.equal(viaTool[0].text, INTUERI_BODY);
});

test("a spell present only in the MANIFEST is fetchable — no per-spell branch in the code", async () => {
  // The acceptance that kills a `switch (name)`: nothing about "nova" exists in
  // this package, and it still resolves, because the manifest is the catalog.
  restoreFetch = serveOrigin([resourceFor("nova", "# nova\nnever heard of")], {
    nova: "# nova\nnever heard of",
  });
  const grimoire = new Grimoire({ site: SITE, verifyKey: publicKey }, noop);
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);
  assert.match((await handlers.fetchSpell("nova"))[0].text, /never heard of/);
  assert.match((await handlers.listSpells())[0].text, /^nova — /);
});

// ── Missing one ─────────────────────────────────────────────────────────────

test("an unknown spell name returns isError + the CATALOG, and no body", async () => {
  const { grimoire, restore } = serveGrimoire();
  restoreFetch = restore;
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);
  const r = await rpc(handlers, "tools/call", {
    name: "fetch_spell",
    arguments: { spell: "no-such-spell" },
  });
  assert.equal(r.result.isError, true);
  const text = r.result.content[0].text;
  assert.match(text, /no-such-spell/); // names the miss
  assert.match(text, /grimoire, intueri/); // lists the CURRENT catalog
  assert.doesNotMatch(text, /START HERE/); // and ships no spell body
});

test("readByName lists the CURRENT verified catalog in its miss, not a baked-in one", async () => {
  const { grimoire, restore } = serveGrimoire();
  restoreFetch = restore;
  await grimoire.preflight();
  await assert.rejects(
    () => grimoire.readByName("absent"),
    (err) => {
      assert.ok(err instanceof UnknownSpellError);
      assert.deepEqual(err.known, ["grimoire", "intueri"]);
      assert.equal(err.audience, "model"); // routed by the declared field
      return true;
    },
  );
});

test("a MISS does not eat the list_changed nudge — the regression that survived a whole release", async () => {
  // observeSetChange is a destructive read. Advancing the baseline before the
  // lookup meant one typo'd name permanently swallowed the notification: not
  // on the miss, not on the retry, not on any later resources/list.
  const good = serveGrimoire();
  restoreFetch = good.restore;
  await good.grimoire.preflight(); // baseline = {grimoire, intueri}
  const { handlers, notified } = handlersOver(good.grimoire);

  good.restore(); // upstream publishes a DIFFERENT spell set
  restoreFetch = serveOrigin([resourceFor("nova", "# nova")], { nova: "# nova" }, { epoch: 2 });

  await assert.rejects(() => handlers.fetchSpell("grimoire"), UnknownSpellError);
  assert.deepEqual(notified, [], "the miss itself reports nothing");

  await handlers.fetchSpell("nova"); // the agent retries correctly
  assert.deepEqual(
    notified,
    ["notifications/resources/list_changed"],
    "the nudge must survive the miss and fire on the next successful read",
  );
});

test("fetchSpell fires the list_changed nudge on a successful read", async () => {
  const good = serveGrimoire();
  restoreFetch = good.restore;
  await good.grimoire.preflight();
  const { handlers, notified } = handlersOver(good.grimoire);

  good.restore();
  restoreFetch = serveOrigin(
    [...TWO_SPELLS(), resourceFor("nova", "# nova")],
    { grimoire: GRIMOIRE_BODY },
    { epoch: 2 },
  );
  await handlers.fetchSpell("grimoire");
  assert.deepEqual(notified, ["notifications/resources/list_changed"]);
});

// ── The trust path is not bypassed ──────────────────────────────────────────

test("a TAMPERED body with nothing known-good REFUSES — a JSON-RPC error, never a body", async () => {
  // Verification failure ≠ agent-recoverable miss: it must not come back as
  // isError tool output that reads like a normal answer.
  const { grimoire, restore } = serveGrimoire({
    bodies: { intueri: "TAMPERED — different bytes entirely" },
  });
  restoreFetch = restore;
  await grimoire.preflight();
  const { handlers } = handlersOver(grimoire);
  const r = await rpc(handlers, "tools/call", {
    name: "fetch_spell",
    arguments: { spell: "intueri" },
  });
  assert.equal(r.result, undefined, "no result envelope — a refusal");
  assert.equal(r.error.code, -32603, "a verification failure IS a server-side fault");
  assert.match(r.error.message, /mismatch/i);
});

test("a last-known-good body is LABELLED as one — the model is told, not just stderr", async () => {
  let loud = false;
  const log = (...a) => {
    if (/VERIFICATION FAILED/.test(a.map(String).join(" "))) loud = true;
  };
  const good = serveGrimoire({ log });
  restoreFetch = good.restore;
  await good.grimoire.preflight();
  const { handlers } = handlersOver(good.grimoire, log);

  // Warm the memo through the RESOURCE surface...
  const { resources } = await handlers.listResources();
  const uri = resources.find((r) => r.name === "grimoire").uri;
  assert.equal((await handlers.readResource({ uri })).contents[0].text, GRIMOIRE_BODY);

  // ...then tamper the origin and read through the TOOL surface.
  good.restore();
  restoreFetch = serveOrigin(TWO_SPELLS(), {
    grimoire: "X".repeat(GRIMOIRE_BODY.length),
    intueri: INTUERI_BODY,
  });

  const r = await rpc(handlers, "tools/call", {
    name: "fetch_spell",
    arguments: { spell: "grimoire" },
  });
  assert.equal(r.result.content.length, 2, "a notice block AND the spell block");
  assert.match(r.result.content[0].text, /could not be verified/);
  assert.equal(
    r.result.content[1].text,
    GRIMOIRE_BODY,
    "the spell's own block stays byte-identical to resources/read",
  );
  assert.ok(loud, "and the operator still gets the loud stderr line");
});

test("a stale CATALOG is labelled too — list_spells and fetch_spell are symmetric", async () => {
  const good = serveGrimoire();
  restoreFetch = good.restore;
  await good.grimoire.preflight(); // warms the manifest memo
  const { handlers } = handlersOver(good.grimoire);

  good.restore();
  restoreFetch = installFetch(() => null); // the origin goes dark

  const r = await rpc(handlers, "tools/call", { name: "list_spells", arguments: {} });
  assert.equal(r.result.content.length, 2, "a notice block AND the catalog");
  assert.match(r.result.content[0].text, /could not be verified/);
  assert.match(r.result.content[1].text, /^grimoire — /);
});

test("BOTH mouths disclose a stale body — not just the tool one", async () => {
  // The re-cast's catch: the tool mouth grew a notice block while
  // resources/read kept returning the same last-known-good bytes unmarked.
  const good = serveGrimoire();
  restoreFetch = good.restore;
  await good.grimoire.preflight();
  const { handlers } = handlersOver(good.grimoire);

  const { resources } = await handlers.listResources();
  const uri = resources.find((r) => r.name === "grimoire").uri;
  await handlers.readResource({ uri }); // warm the memo

  good.restore();
  restoreFetch = serveOrigin(TWO_SPELLS(), {
    grimoire: "X".repeat(GRIMOIRE_BODY.length),
    intueri: INTUERI_BODY,
  });

  const viaResource = await handlers.readResource({ uri });
  assert.equal(viaResource.contents.length, 2, "resources/read discloses too");
  assert.match(viaResource.contents[0].text, /could not be verified/);
  assert.equal(viaResource.contents[1].text, GRIMOIRE_BODY);

  const viaTool = await handlers.fetchSpell("grimoire");
  assert.equal(
    viaTool[0].text,
    viaResource.contents[0].text,
    "and both mouths use the SAME wording",
  );
});

test("fetch_spell and resources/read share ONE memo", async () => {
  const good = serveGrimoire();
  restoreFetch = good.restore;
  await good.grimoire.preflight();
  const { handlers } = handlersOver(good.grimoire);

  const { resources } = await handlers.listResources();
  const uri = resources.find((r) => r.name === "grimoire").uri;
  await handlers.readResource({ uri }); // warms the memo via the resource mouth

  good.restore();
  restoreFetch = serveOrigin(TWO_SPELLS(), {
    grimoire: "X".repeat(GRIMOIRE_BODY.length),
    intueri: INTUERI_BODY,
  });
  const viaTool = await handlers.fetchSpell("grimoire");
  assert.equal(viaTool.length, 2, "a notice block AND the spell");
  assert.match(viaTool[0].text, /could not be verified/);
  assert.equal(viaTool[1].text, GRIMOIRE_BODY, "the tool mouth hit the resource mouth's memo");
});

test("resources/list discloses staleness on rows that HAVE a description", async () => {
  // The disclosure rode on the description FALLBACK — it was appended only to
  // rows lacking a description. Every row of the live manifest has one, so the
  // notice could not fire against the real origin; it fired only for fixtures.
  // `resourceFor` defaults to no description, so the whole suite exercised the
  // path production never takes, and the production path no test took.
  const AUTHORED = {
    grimoire: "START HERE — the index.",
    intueri: "Contemplate the code.",
  };
  const described = Object.entries(AUTHORED).map(([name, description]) =>
    resourceFor(name, name === "grimoire" ? GRIMOIRE_BODY : INTUERI_BODY, { description }),
  );
  const good = serveGrimoire({ resources: described });
  restoreFetch = good.restore;
  await good.grimoire.preflight();
  const { handlers } = handlersOver(good.grimoire);
  await handlers.listResources(); // warm the manifest memo

  good.restore();
  restoreFetch = installFetch(() => null); // the origin goes dark

  const { resources } = await handlers.listResources();
  for (const r of resources) {
    // BOTH halves, and the first one is what makes this test discriminate.
    // Asserting only the notice passed even when `resourceFor` could not carry
    // a description at all — the fallback text gets the notice too, so the
    // authored-row path stayed untested by the test written to cover it.
    // Requiring the AUTHOR's own words to survive is what proves the row went
    // down the described branch.
    assert.ok(
      r.description.startsWith(AUTHORED[r.name]),
      `row ${r.name} did not take the authored-description path: ${r.description}`,
    );
    assert.match(
      r.description,
      /could not be verified/,
      `row ${r.name} kept its author description and disclosed nothing`,
    );
  }
});
