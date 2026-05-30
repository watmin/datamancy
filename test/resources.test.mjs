import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  fetchAndVerify,
  HashMismatchError,
  SizeMismatchError,
  ResourceFetchError,
} from "../dist/resources.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const body = Buffer.from("# cernere\nspell body"); // 20 bytes
const sha256 = createHash("sha256").update(body).digest("hex");
const resource = {
  name: "cernere",
  uri: "https://datamancy.dev/cernere/SKILL.md",
  mimeType: "text/markdown",
  sha256,
  size: body.length,
};

test("returns verified content when hash + size match", async () => {
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const r = await fetchAndVerify(resource);
  assert.equal(r.text, body.toString());
});

test("fetches the url override (immutable blob) and returns the verified content", async () => {
  let seen;
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(body, { status: 200 });
  };
  const r = await fetchAndVerify(
    resource,
    undefined,
    `https://mirror.internal/blobs/sha256/${sha256}`,
  );
  assert.match(seen, /mirror\.internal\/blobs/); // fetched from the override
  assert.equal(r.text, body.toString()); // and the verified content came back
});

test("rejects on hash mismatch (same size, different bytes) — tamper", async () => {
  const tamper = Buffer.from("# cernere\nXpell body"); // same length, 1 byte off
  assert.equal(tamper.length, body.length);
  globalThis.fetch = async () => new Response(tamper, { status: 200 });
  await assert.rejects(() => fetchAndVerify(resource), HashMismatchError);
});

test("rejects on size mismatch", async () => {
  globalThis.fetch = async () => new Response(Buffer.from("short"), { status: 200 });
  await assert.rejects(() => fetchAndVerify(resource), SizeMismatchError);
});

test("rejects on transport failure (non-200)", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  await assert.rejects(() => fetchAndVerify(resource), ResourceFetchError);
});

test("rejects on transport failure (fetch throws)", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await assert.rejects(() => fetchAndVerify(resource), ResourceFetchError);
});
