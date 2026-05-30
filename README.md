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

## Trust model: living

The pinned **Ed25519 public key** (`src/pinned-pubkey.ts`) is the only
constant. It verifies *any* manifest the offline private key signs —
including ones that don't exist yet — exactly the way TLS pins a CA or SSH
pins a host key. So **the website is the content**: edit a spell, re-sign
the manifest, push, and every consumer sees it on the next call. There is
no manifest hash baked into this package and no republish-per-spell.

**Layer 1 — per-resource hashes.** The manifest lists a SHA-256 for every
spell. Each fetched resource is hashed locally and compared; mismatch =
the content is refused and a structured error reported.

**Layer 2 — signed manifest.** The manifest is signed with an Ed25519
detached signature (`manifest.json.sig`). Every load verifies it against
the pinned public key before parsing. A manifest the key didn't sign is
rejected and no content loads.

**Stateless + always-fresh.** It's a static website, so this adapter holds
no boot snapshot and has no reload command. Every list/read fetches the
manifest fresh and verifies it, so content upgrades immediately. Boot does
one preflight fetch+verify to fail fast on misconfiguration.

**Resilience (write-only-on-verified memo).** Only verified content is ever
remembered, so the memo can never hold anything forged. On a transient
**transport** failure (timeout/DNS/5xx) the last-known-good is served with
a quiet log. On a **verification** failure (bad signature/hash) the
last-known-good is still served — the bad bytes are refused and never
remembered — but the log is **loud**: a tamper is never silent. Warm
fetches are bounded to ~3× the measured baseline latency, so a degraded
network bails to last-known-good fast instead of hanging.

## What this defeats

| Attack | Defended? |
|---|---|
| Tamper one spell file | ✓ Layer 1 (hash mismatch on fetch) |
| Tamper manifest + spell files together | ✓ Layer 2 (signature invalid) |
| Full website compromise + replace everything | ✓ Layer 2 (attacker lacks the offline private key) |
| Website-only compromise, *replay an old signed manifest* | ~ accepted: authentic but stale; low-stakes for a grimoire, closable later with a signed monotonic version, no freeze needed |
| Website + offline private key both compromised | ✗ (the key is the anchor; protect it) |

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
