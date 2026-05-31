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

## Pinning, versions, and self-hosting

By default the server follows `latest` (live). The consumer chooses a
stronger posture entirely via env vars in the same config `"env": { … }`:

| Env var | Effect |
|---|---|
| `DATAMANCY_PIN=sha256:<manifest-hash>` | Freeze to one immutable, audited version. Trusts nothing but the hash. |
| `DATAMANCY_VERSION=<label>` | Freeze to a version by its ISO8601 label (resolved by walking the signed chain — the 100 most recent; pin older versions by exact hash). |
| `DATAMANCY_SITE=<origin>` | Fetch from a self-hosted mirror — even raw git links. The pinned key still proves authenticity, so you host the bytes but can't forge them. |

A version is the **whole grimoire frozen as one immutable snapshot** (like
a container digest), identified by the manifest's own SHA-256. To discover
what to pin, run the CLI:

```bash
npx -y datamancy current     # the current version + the exact DATAMANCY_PIN line to copy
npx -y datamancy versions    # the 50 most recent, newest first (pin older by exact hash)
```

Pinning + self-hosting compose: `DATAMANCY_SITE` + `DATAMANCY_PIN` gives a
frozen, air-gappable grimoire served from your own infra and still
cryptographically verified against the pinned key.

## Trust model: living

The pinned **ECDSA P-256 public key** (`src/pinned-pubkey.ts`) is the only
constant. It verifies *any* manifest the matching private key signs —
including ones that don't exist yet — exactly the way TLS pins a CA or SSH
pins a host key. The private key lives **non-exportably in AWS KMS** (it
never touches a disk; every signature is logged in CloudTrail). So **the
website is the content**: edit a spell, re-sign the manifest, push, and
every consumer sees it on the next call. No manifest hash is baked into
this package and there is no republish-per-spell.

**Layer 1 — per-resource hashes.** The manifest lists a SHA-256 and byte
size for every spell. Each fetched resource is read under a size cap (so a
compromised origin can't exhaust memory), hashed locally and compared, and
decoded as strict UTF-8; any mismatch — hash, size, or a non-text body — is
refused and a structured error reported.

**Layer 2 — signed manifest.** The manifest at
`datamancy.dev/.well-known/mcp/manifest.json` is signed with an ECDSA
P-256 detached signature alongside it at `manifest.json.sig`. Every load
verifies it against the pinned public key before parsing — including a
*malformed* signature, which is treated as a verification failure, never a
transport blip. A manifest the key didn't sign is rejected and no content
loads.

**Stateless + always-fresh.** It's a static website, so serving holds no
cache and there is no reload command. Every list/read fetches the manifest
fresh and verifies it, so content upgrades immediately. Boot does one
preflight fetch+verify (to fail fast on misconfiguration) which also seeds
the last-known-good memo — that memo is a fallback, not a serving cache.

**Resilience (write-only-on-verified memo).** Only verified content is ever
remembered, so the memo can never hold anything forged. On a transient
**transport** failure (timeout/DNS/5xx) the last-known-good is served with
a quiet log. On a **verification** failure (bad signature/hash) the
last-known-good is still served — the bad bytes are refused and never
remembered — but the log is **loud**: a tamper is never silent. Once a
verified copy exists, fetches are bounded by a fixed ~5s backstop, so a
genuinely stuck fetch bails to last-known-good rather than hanging.

## What this defeats

| Attack | Defended? |
|---|---|
| Tamper one spell file | ✓ Layer 1 (hash mismatch on fetch) |
| Tamper manifest + spell files together | ✓ Layer 2 (signature invalid) |
| Full website compromise + replace everything | ✓ Layer 2 (attacker lacks the non-exportable KMS private key) |
| Website-only compromise, *replay an old signed manifest* | ~ **in-session: refused** — the kernel rejects a `latest` whose signed `epoch` regressed below the highest it verified this session (`RollbackError`, loud). **Cross-restart / first-contact: accepted by design** — authentic but stale, low-stakes for a grimoire; a pinned consumer is immune (froze a known-good hash). |
| Website + KMS signing key both compromised | ✗ (the key is the anchor; it's non-exportable in KMS — protect the AWS account) |

## Verifying the pinned key

The pinned ECDSA P-256 key ships in this package (`dist/pinned-pubkey.js`).
Trust-on-first-use is only as strong as your ability to confirm the key is the
real one, so its fingerprint — `SHA-256` over the DER-encoded public key — is:

```
09db7668a3a0ea27c52de060081c0a70584181c02f9eb94eff6941f904b5f12e
```

Compute it yourself and compare (the `npm install` makes the package importable
— the `npx` MCP-config install above creates no local `node_modules`):

```bash
npm install datamancy
node --input-type=module -e 'import {createPublicKey, createHash} from "node:crypto"; import {PINNED_PUBKEY_PEM} from "datamancy/pinned-pubkey"; const der = createPublicKey({key: PINNED_PUBKEY_PEM, format: "pem"}).export({type: "spki", format: "der"}); console.log(createHash("sha256").update(der).digest("hex"))'
```

Cross-check that fingerprint against independent channels before relying on the
package — it should match in all of them:
- the git source — `github.com/watmin/datamancy` (`src/pinned-pubkey.ts`)
- the practitioner identity card at [datamancer.dev](https://datamancer.dev)
- a DNS `TXT` record on separate infrastructure from npm, github, and the
  website: `dig +short TXT _datamancy-key.datamancer.dev`

If the key in your install doesn't match these, **do not trust it.**

## Built to never change

This package is designed to be **published once and never patched** — the
pinned key is the only constant, and the website is the content. What the
website may evolve freely versus what would require a new major is the
**[forward-compatibility contract](CONTRACT.md)**, enforced by tests. A
breaking format change is signalled by `schemaVersion`: a frozen client
refuses a newer major *loud* ("upgrade the package") rather than misreading
it. Crypto-agility and binary content are explicit end-of-life conditions,
not in-place patches.

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
