// The tarball must contain what the shipped docs point at.
//
// `README.md` ships, and it told the reader to "see `RECOVERY.md`" at exactly
// the moment a major bump should make them suspicious — but `RECOVERY.md` was
// not in `package.json`'s `files`, so an installed consumer following that
// pointer found nothing. A dangling reference is cheap to create (the file is
// right there in the repo) and invisible to every test that runs from the repo,
// which is every test. Only the packing manifest can see it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

/** Files named by `files`, as plain names (directory entries dropped — a
 *  reference into `dist/` is a code path, not a doc pointer). */
const shipped = new Set(pkg.files.filter((f) => !f.endsWith("/")));

/** The docs that ship, and therefore whose pointers a consumer can follow. */
const shippedDocs = [...shipped].filter((f) => f.endsWith(".md"));

test("the shipped doc set is non-vacuous — README and CONTRACT are in it", () => {
  // Without this, an empty `files` would make every assertion below pass.
  assert.ok(shippedDocs.includes("README.md"), `shipped docs: ${shippedDocs.join(", ")}`);
  assert.ok(shippedDocs.includes("CONTRACT.md"));
});

test("every root .md a SHIPPED doc points at is itself shipped", () => {
  // Scoped to root-level markdown deliberately. References into `test/`,
  // `scripts/` and `src/` are references to the GIT SOURCE, and CONTRACT.md
  // says so in as many words — those are not broken pointers, they are
  // pointers to a different artifact. A bare `FOO.md` is not: it reads as a
  // sibling of the file naming it.
  const dangling = [];
  for (const doc of shippedDocs) {
    const text = readFileSync(join(root, doc), "utf-8");
    // The lookbehind excludes a preceding `/` or word character, so
    // `test/FOO.md` and `xFOO.md` are not root references. It must NOT exclude
    // a backtick: every such pointer in these docs is written as `RECOVERY.md`,
    // so excluding it made this test blind to the only case it exists for —
    // it passed with RECOVERY.md removed from `files`.
    for (const [, name] of text.matchAll(/(?<![\w/])([A-Z][A-Z0-9_]*\.md)\b/g)) {
      if (shipped.has(name)) continue;
      if (!existsSync(join(root, name))) continue; // not ours; a URL or an example
      dangling.push(`${doc} → ${name}`);
    }
  }
  assert.deepEqual(
    [...new Set(dangling)],
    [],
    "a shipped doc points at a repo file the tarball does not contain",
  );
});

test("the bin entry and the module export both exist in the shipped tree", () => {
  // `files` ships `dist/`, but nothing checks the two paths package.json
  // actually promises resolve inside it.
  for (const p of [pkg.bin?.datamancy, pkg.main, pkg.exports?.["."]].filter(Boolean)) {
    const rel = String(p).replace(/^\.\//, "");
    assert.ok(existsSync(join(root, rel)), `package.json points at ${rel}, which does not exist`);
    assert.ok(
      pkg.files.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f)),
      `${rel} is promised by package.json but not covered by \`files\``,
    );
  }
});
