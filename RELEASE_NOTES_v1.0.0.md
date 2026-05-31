# datamancy v1.0.0 — the frozen kernel

`datamancy` is a cryptographically verifiable static MCP server. It exposes the [datamancy.dev](https://datamancy.dev) grimoire to any MCP-aware LLM, and **hashes every spell locally against a signed manifest before a single byte reaches the model.** Tampered content never arrives.

## What 1.0.0 means

This release is **published once and never patched.** The pinned ECDSA P-256 public key is the only constant; the website is the content. A frozen kernel can verify content that doesn't exist yet — so the grimoire evolves freely while this code stays still.

- **The key is the trust.** The private key lives non-exportably in AWS KMS; the public key is pinned in this package. Verification is the key, not secrecy of the code (Kerckhoffs).
- **The major version is the key generation.** `1.x` trusts this key. Lose or rotate it and the line continues at `2.x`, then `3.x` — never an in-place swap. A breaking format change works the same way: bump `schemaVersion` *and* mint a new major. Old clients fail loud and safe, never silently misread.
- **Zero runtime dependencies.** Every line of the trust path is in this package. The crypto is `node:crypto`, the transport is the platform `fetch`, and nothing else gets a vote.

## Verify before you trust

The pin is only as strong as your ability to confirm it. The key's fingerprint — SHA-256 over its DER public key — is:

```
09db7668a3a0ea27c52de060081c0a70584181c02f9eb94eff6941f904b5f12e
```

Compute it yourself and cross-check it against three independent channels — the npm source, [datamancer.dev](https://datamancer.dev), and `dig +short TXT _datamancy-key.datamancer.dev`. If your install disagrees with all three, do not trust it.

## Install

```json
{ "mcpServers": { "datamancy": { "command": "npx", "args": ["-y", "datamancy"] } } }
```

## The frozen boundary

What the website may evolve vs. what would require a new major is the forward-compatibility **CONTRACT.md**, enforced by tests (115 green in this release). Crypto deprecation and binary content are documented end-of-life conditions, not in-place patches. Recovery and key-loss runbook: **RECOVERY.md**.

## Provenance

Published via GitHub Trusted Publishing (tokenless OIDC) with **SLSA build provenance** and npm package provenance — this release is cryptographically attestable to its source and workflow.
