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

/** Remove block and line comments, leaving string literals intact — an import
 *  specifier is a string, so the scan still sees every real one. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      out += src[i++];
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") out += src[i++];
        out += src[i++];
      }
      out += src[i++] ?? "";
    } else {
      out += src[i++];
    }
  }
  return out;
}

test("the comment-stripper does not eat import specifiers (positive control)", () => {
  // A scanner is only trustworthy if it still SEES what it is hunting. Prove
  // both directions before relying on the count.
  const stripped = stripComments(
    `// import "commented-out"\n/* import "block" */\nimport x from "real-one";\nconst s = 'import "in-a-string"';`,
  );
  assert.match(stripped, /import x from "real-one"/, "real imports survive");
  assert.doesNotMatch(stripped, /commented-out/, "line comments go");
  assert.doesNotMatch(stripped, /block/, "block comments go");
  assert.match(stripped, /in-a-string/, "string literals survive");
});

test("the COMPILED dist imports only node: builtins + relative paths (zero-dep in FACT)", () => {
  // The headline is "every line of the trust path lives in this repo." Guard it
  // at the IMPORT level, not just package.json: a bare specifier in dist would
  // be a runtime dependency that ships green if it weren't also added to
  // package.json. This makes the headline self-enforcing.
  const distDir = join(ROOT, "dist");
  const offenders = [];
  for (const file of readdirSync(distDir).filter((f) => f.endsWith(".js"))) {
    // Strip comments FIRST. The scan is a claim about what dist imports, and a
    // regex over raw text counts a comment as code — a doc-comment mentioning
    // `import("datamancy")` was reported as a bare-specifier dependency. A
    // census that cannot tell code from prose reports drift that isn't there,
    // and trains the next reader to reword comments around the gate instead of
    // trusting it.
    const src = stripComments(readFileSync(join(distDir, file), "utf-8"));
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
