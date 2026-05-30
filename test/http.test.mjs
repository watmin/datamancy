// Bounded body reads (OOM-proofing) + strict UTF-8 decoding. These pin the
// two availability/forward-compat fixes: a body can never be buffered past a
// known bound, and a non-UTF-8 spell fails LOUD instead of shipping mojibake.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  readCappedBody,
  BodyTooLargeError,
  MAX_MANIFEST_BYTES,
  MAX_SIGNATURE_BYTES,
} from "../dist/http.js";
import {
  fetchAndVerify,
  SizeMismatchError,
  EncodingError,
} from "../dist/resources.js";
import { fetchManifestBytes } from "../dist/manifest.js";
import { fetchSignature } from "../dist/signature.js";
import {
  resourceFor,
  installFetch,
  bodyResponse,
  countingStream,
} from "./helpers.mjs";

let restore = () => {};
afterEach(() => restore());

test("readCappedBody returns a body at exactly the cap", async () => {
  const body = new Uint8Array(100);
  const out = await readCappedBody(new Response(body), 100);
  assert.equal(out.byteLength, 100);
});

test("readCappedBody returns a short body unchanged", async () => {
  const out = await readCappedBody(new Response(new Uint8Array(10)), 100);
  assert.equal(out.byteLength, 10);
});

test("readCappedBody throws BodyTooLargeError one byte over the cap", async () => {
  await assert.rejects(
    () => readCappedBody(new Response(new Uint8Array(101)), 100),
    BodyTooLargeError,
  );
});

test("readCappedBody CANCELS the stream early — never drains an oversized body", async () => {
  // 1000 chunks of 1 KiB = ~1 MiB available, cap at 4 KiB. Prove we stop
  // pulling almost immediately rather than buffering the whole stream.
  const counter = { pulled: 0 };
  const stream = countingStream(1000, 1024, counter);
  await assert.rejects(
    () => readCappedBody(new Response(stream), 4 * 1024),
    BodyTooLargeError,
  );
  assert.ok(
    counter.pulled <= 6,
    `cancelled early after ${counter.pulled} chunks (not all 1000)`,
  );
});

test("content fetch: an over-long body is a SizeMismatchError (verification), not OOM", async () => {
  // Declared size 10, origin serves 5000 bytes. The read is capped at 10, so
  // the process never buffers 5000 — it rejects as a size mismatch.
  const resource = resourceFor("cernere", "0123456789"); // size 10
  restore = installFetch(() => bodyResponse(new Uint8Array(5000)));
  const err = await fetchAndVerify(resource, undefined, "https://x/c").catch(
    (e) => e,
  );
  assert.ok(err instanceof SizeMismatchError, `got ${err?.constructor.name}`);
  assert.equal(err.severity, "verification");
});

test("content fetch: a non-UTF-8 body is an EncodingError (verification), not mojibake", async () => {
  // A JPEG header: valid bytes, hash + size match, but not UTF-8 text.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const resource = resourceFor("image", jpeg, { mimeType: "image/jpeg" });
  restore = installFetch(() => bodyResponse(jpeg));
  const err = await fetchAndVerify(resource, undefined, "https://x/i").catch(
    (e) => e,
  );
  assert.ok(err instanceof EncodingError, `got ${err?.constructor.name}`);
  assert.equal(err.severity, "verification");
});

test("content fetch: valid multibyte UTF-8 passes intact", async () => {
  const body = Buffer.from("# spell — café 🜍 naïve\n", "utf-8");
  const resource = resourceFor("uni", body);
  restore = installFetch(() => bodyResponse(body));
  const { text } = await fetchAndVerify(resource, undefined, "https://x/u");
  assert.equal(text, body.toString("utf-8"));
});

test("manifest fetch: an over-ceiling body is a transport ManifestFetchError", async () => {
  restore = installFetch(() =>
    bodyResponse(new Uint8Array(MAX_MANIFEST_BYTES + 1)),
  );
  const err = await fetchManifestBytes("https://x/manifest.json").catch(
    (e) => e,
  );
  assert.equal(err?.name, "ManifestFetchError");
  assert.equal(err.severity, "transport");
});

test("signature fetch: an over-ceiling body is a transport SignatureFetchError", async () => {
  restore = installFetch(() =>
    bodyResponse(new Uint8Array(MAX_SIGNATURE_BYTES + 1)),
  );
  const err = await fetchSignature("https://x/manifest.json.sig").catch(
    (e) => e,
  );
  assert.equal(err?.name, "SignatureFetchError");
  assert.equal(err.severity, "transport");
});
