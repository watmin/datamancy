// The MCP handler glue (formerly untested, inline in index.ts). Pins: the read
// response echoes the REQUESTED uri (so list() and read() agree on the
// identifier), the list_changed nudge fires only on a spell-SET change, and
// the list mapping (description fallback, resolved uri) is correct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrimoireHandlers } from "../dist/handlers.js";

const ABS = "https://datamancy.dev/cernere/SKILL.md";

/** A fake grimoire exposing only what the handlers call. `setChange` is
 *  whatever read() should surface. Note resource.uri is the RAW relative path,
 *  deliberately different from the absolute uri the client requests. */
function fakeGrimoire({ setChange = null } = {}) {
  return {
    list: async () => ({
      resources: [
        { uri: ABS, name: "cernere", mimeType: "text/markdown" },
        { uri: `${ABS}2`, name: "withDesc", mimeType: "text/markdown", description: "custom" },
      ],
      setChange,
    }),
    read: async (uri) => ({
      fetched: {
        resource: { uri: "cernere/SKILL.md", mimeType: "text/markdown" },
        text: "VERIFIED BODY",
      },
      setChange,
      requested: uri,
    }),
  };
}

function build(grimoire) {
  const notified = [];
  const logs = [];
  const handlers = createGrimoireHandlers(
    grimoire,
    { name: "datamancy", version: "0.0.x" },
    (m) => notified.push(m),
    (...a) => logs.push(a.map(String).join(" ")),
  );
  return { handlers, notified, logs };
}

test("readResource echoes the REQUESTED uri, not the manifest's raw relative path", async () => {
  const { handlers } = build(fakeGrimoire());
  const res = await handlers.readResource({ uri: ABS });
  assert.equal(res.contents[0].uri, ABS); // absolute, as requested — not "cernere/SKILL.md"
  assert.equal(res.contents[0].text, "VERIFIED BODY");
  assert.equal(res.contents[0].mimeType, "text/markdown");
});

test("a spell-SET change fires the list_changed nudge + a log", async () => {
  const { handlers, notified, logs } = build(
    fakeGrimoire({ setChange: { version: "v2", added: ["nova"], removed: [] } }),
  );
  await handlers.readResource({ uri: ABS });
  assert.deepEqual(notified, ["notifications/resources/list_changed"]);
  assert.ok(logs.some((l) => /nova/.test(l) && /re-source/.test(l)));
});

test("listResources ALSO fires the nudge — the dominant refresh path (resources/list)", async () => {
  // The third-assault fix: a client re-sourcing via resources/list (the MCP
  // refresh primitive) must get list_changed too, not only one that reads.
  const { handlers, notified } = build(
    fakeGrimoire({ setChange: { version: "v3", added: ["arx"], removed: [] } }),
  );
  await handlers.listResources();
  assert.deepEqual(notified, ["notifications/resources/list_changed"]);
});

test("no set change → NO notification (a content edit must not nudge)", async () => {
  const { handlers, notified } = build(fakeGrimoire({ setChange: null }));
  await handlers.readResource({ uri: ABS });
  assert.equal(notified.length, 0);
});

test("listResources maps resolved uri/name/mimeType and supplies a description fallback", async () => {
  const { handlers } = build(fakeGrimoire());
  const { resources } = await handlers.listResources();
  assert.equal(resources.length, 2);
  assert.equal(resources[0].uri, ABS);
  assert.match(resources[0].description, /SHA-256 verified/); // fallback
  assert.equal(resources[1].description, "custom"); // honored when present
});
