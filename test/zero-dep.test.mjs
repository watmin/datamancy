// The headline guarantee: every line of the trust path lives in THIS repo, with
// ZERO runtime dependencies. A self-dependency or any runtime dep silently
// breaks the entire posture of a cryptographic kernel — and a never-patched
// 1.0.0 can never take it back. publish.yml gates on `npm test`, so this turns
// any dependency drift (including a stray `npm install datamancy` in the repo)
// into a RED BUILD before a tag can ever be cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8",
  ),
);

test("the kernel has ZERO runtime dependencies (the whole trust posture)", () => {
  const deps = Object.keys(pkg.dependencies || {});
  assert.deepEqual(
    deps,
    [],
    `runtime dependencies must be empty; found: ${deps.join(", ")}`,
  );
});

test("the kernel does not depend on ITSELF (no recursive self-reference)", () => {
  assert.ok(
    !(pkg.dependencies && pkg.dependencies[pkg.name]),
    "self-dependency detected — the zero-dep kernel must never depend on itself",
  );
});
