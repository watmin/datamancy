// The headline guarantee: every line of the trust path lives in THIS repo, with
// ZERO runtime dependencies. A self-dependency or any runtime dep silently
// breaks the entire posture of a cryptographic kernel — and a never-patched
// 1.0.0 can never take it back. publish.yml gates on `npm test`, so this turns
// any dependency drift (including a stray `npm install datamancy` in the repo)
// into a RED BUILD before a tag can ever be cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

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

test("the COMPILED dist imports only node: builtins + relative paths (zero-dep in FACT)", () => {
  // The headline is "every line of the trust path lives in this repo." Guard it
  // at the IMPORT level, not just package.json: a bare specifier in dist would
  // be a runtime dependency that ships green if it weren't also added to
  // package.json. This makes the headline self-enforcing.
  const distDir = join(ROOT, "dist");
  const offenders = [];
  for (const file of readdirSync(distDir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(distDir, file), "utf-8");
    for (const m of src.matchAll(
      /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g,
    )) {
      const spec = m[1];
      if (
        !spec.startsWith("node:") &&
        !spec.startsWith("./") &&
        !spec.startsWith("../") &&
        !spec.startsWith("/")
      ) {
        offenders.push(`${file}: ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `dist must import only node: builtins + relative paths; bare specifiers found: ${offenders.join(", ")}`,
  );
});
