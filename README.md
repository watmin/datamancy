# datamancy

A cryptographically verifiable static MCP server backed by
[datamancy.dev](https://datamancy.dev). Every spell content is SHA-256
verified before any prompt reaches the LLM.

## What this is

[MCP](https://modelcontextprotocol.io) is Anthropic's protocol for
connecting LLMs to external tools and resources. This package is an MCP
server that exposes the [datamancy](https://datamancer.dev) grimoire — a
library of focused spells (skills, prompts, voice disciplines) — to any
MCP-aware LLM client (Claude Code, Cursor, etc.).

The trust model is the novel part: instead of running a live server (a
hackable surface), the spell content lives as raw markdown on
[datamancy.dev](https://datamancy.dev) and a SHA-256 manifest is
published alongside it. This package fetches the manifest, fetches each
spell on demand, **hashes the content locally**, and compares against
the manifest. Mismatch = rejection. **Tampered content never reaches the
LLM.**

## Install + use

Add to your MCP client config (Claude Code / Cursor / etc.):

```json
{
  "mcpServers": {
    "datamancy": {
      "command": "npx",
      "args": ["-y", "datamancy"]
    }
  }
}
```

That's it. The package boots a stdio MCP server, fetches the verified
manifest, and exposes each spell as an MCP resource. Your LLM client
shows them in the resources list; selecting one loads its content
(post-verification).

## Trust model (current state)

**Tier 1 (active):** Manifest contains per-resource SHA-256 hashes.
Every fetched resource is hashed locally and compared. Mismatch = the
package refuses to return the content and reports a structured error.

**Tier 2 (active):** The manifest itself is signed with an Ed25519
detached signature (`manifest.json.sig` next to `manifest.json`). The
matching public key is **pinned in this package's source**
(`src/pinned-pubkey.ts`). On every boot, the package verifies the
signature before parsing the manifest. Tampering with the manifest
requires also possessing the offline private key — invalid signature =
the adapter exits immediately and no content is loaded.

**Tier 3 (planned):** The SHA-256 of the manifest itself will be baked
into this package at publish time as defense-in-depth across the npm
publish chain. Even if both the website and the signing key are
compromised, tampering is detectable because the pinned manifest hash
in the npm package source must also change to match.

## What this defeats

| Attack | Defended? |
|---|---|
| Tamper one spell file | ✓ Tier 1 (hash mismatch on fetch) |
| Tamper manifest + spell files together | ✓ Tier 2 (signature invalid) |
| Full website compromise + replace everything | ✓ Tier 2 (attacker lacks the private key) |
| Website + private key both compromised | ✗ (Tier 3 will close this) |
| Website + key + npm publish all compromised | (Game over) |

## Architecture

Three domains, each with a single purpose:

- **algebraic-intelligence.dev** — the chronicle (story, polished,
  rendered)
- **[datamancer.dev](https://datamancer.dev)** — the practitioner's
  identity card (raw markdown)
- **[datamancy.dev](https://datamancy.dev)** — the grimoire + MCP server
  (raw markdown, hash-verified)

Full design lives in
[algebraic-intelligence.dev/docs/static-mcp/DESIGN.md](https://github.com/watmin/algebraic-intelligence.dev/blob/main/docs/static-mcp/DESIGN.md).

## License

MIT
