# datamancy

A cryptographically verifiable static MCP server backed by
[datamancy.dev](https://datamancy.dev). Every spell's content is SHA-256
verified before any prompt reaches the LLM.

## What this is

[MCP](https://modelcontextprotocol.io) is Anthropic's protocol for
connecting LLMs to external tools and resources. This package is an MCP
server that exposes the [datamancy](https://datamancy.dev) grimoire — a
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
      "args": ["-y", "datamancy@1"]
    }
  }
}
```

**Pin the major (`datamancy@1`).** A bare `datamancy` resolves against the
registry on every launch, so a new release changes what your client runs without
you touching anything — including what MCP capabilities it advertises. `@1` still
picks up fixes within the major; it never silently crosses a trust-root change,
because a trust-root change can only happen at a major. The converse does not
hold — a major may also be minted for reasons that leave the key untouched, so
seeing `@2` is a prompt to check rather than proof the root moved (see
`RECOVERY.md`).

That's it. The package boots a stdio MCP server, fetches the verified manifest,
and exposes the grimoire through **two surfaces over one pipeline**:

| surface | how the client uses it |
|---|---|
| **resources** — `resources/list`, `resources/read` | Your client shows the spells in its resources list; selecting one loads its content. |
| **tools** — `list_spells`, `fetch_spell` | For clients that only wire *tools* through to the model. `list_spells` returns every spell name + description; `fetch_spell {"spell": "<name>"}` returns that spell's markdown. |

Both resolve against the same signed manifest and run the same verification, and
return the same bytes.

**Which one applies to you?** You do not have to know in advance — the server
advertises both and your host picks. If you are unsure which your host used:
open its resources/context picker and look for the spells. If they are there,
the resource surface is live. If they are not, your host is tools-only, and the
model reaches the grimoire by calling `list_spells` and then `fetch_spell`.

### Why the tool surface exists (and why `1.1.0` was necessary)

A grimoire is a **library of documents**. MCP has a surface for exactly that —
*resources* — and `1.0.0` was honestly that and nothing else: list the spells,
read one, done. There is no verb to call.

The problem is not the protocol, it is what hosts do with it. The spec is
explicit that a client **must not** call `tools/list` when `initialize` did not
advertise a `tools` capability. Several harnesses call it anyway, and then treat
the spec-correct `-32601 Method not found` as a **dead server**. Measured
directly against Grok Build 1.0.4: the handshake succeeded, `resources/list`
returned the full grimoire, and `mcp doctor` still reported the server as
*failing* — solely because of that one unadvertised method. The same shape has
been reported on other harnesses. Declaring `capabilities = ["resources"]` in
the host's own config does not stop it asking.

So a resources-only server can be completely correct and still be unusable, and
on a tools-only host the grimoire is unreachable even after a perfect handshake
— the agent never sees the spells at all.

`1.1.0` answers that without pretending datamancy became an action server. The
tools are a **resource accessor**: a second mouth on the same pipeline, not a
second catalog. `fetch_spell` resolves a name against the same signed manifest
`resources/read` uses, runs the same ECDSA + SHA-256 verification, and returns
the same bytes. There is no per-spell tool and no branch in the code — a spell
added to the website is a new manifest row, reachable through both surfaces with
no package change. `resources/list` and `resources/read` are untouched.

The kernel did not need this; the hosts did. Until they honour the capability
handshake, this is how the grimoire stays reachable on them.

**The tool argument is the short NAME, not the uri.** `list_spells` prints the
names; the resource surface addresses the same spells by uri. They are different
keys for the same rows:

```
> list_spells {}
grimoire — START HERE: the index; reading it installs the practice…
intueri — Contemplate whether the code speaks…
…

> fetch_spell {"spell": "intueri"}
(the full verified markdown of the intueri spell)
```

## Pinning, versions, and self-hosting

By default the server follows `latest` (live). The consumer chooses a
stronger posture entirely via env vars in the same config `"env": { … }`:

| Env var | Effect |
|---|---|
| `DATAMANCY_PIN=sha256:<manifest-hash>` | Freeze to one immutable, audited version. Trusts nothing but the hash. |
| `DATAMANCY_VERSION=<label>` | Freeze to a version by its ISO8601 label, resolved by walking the signed chain. Reaches the **100 most recent**; `versions` below lists the **50** most recent, so labels 51–100 resolve but are not listed. Older than that: pin by exact hash. |
| `DATAMANCY_SITE=<origin>` | Fetch from a self-hosted mirror. See *Self-hosting*, below. |
| `DATAMANCY_TIMEOUT_MS=<ms>` | **Set** the cold fetch budget (default 15000 cold / 5000 warm, the warm bound derived from it). A larger value suits a slow self-hosted origin; a smaller one *lowers* the default. Clamped to `[1000, 2147483647]`. |

To freeze a posture, add an `"env"` block to the same config — e.g. pin an
exact version:

```json
{
  "mcpServers": {
    "datamancy": {
      "command": "npx",
      "args": ["-y", "datamancy@1"],
      "env": { "DATAMANCY_PIN": "sha256:<manifest-hash>" }
    }
  }
}
```

A version is the **whole grimoire frozen as one immutable snapshot** (like
a container digest), identified by the manifest's own SHA-256. To discover
what to pin, run the CLI:

```bash
npx -y datamancy current     # the current version + the exact DATAMANCY_PIN line to copy
npx -y datamancy versions    # the 50 most recent, newest first (pin older by exact hash)
```

## Self-hosting

An organization can serve the grimoire from its own host — `https://grimoire.corp.example`, an
internal mirror, an air-gapped network. The pinned key still proves every byte,
so you host the content but cannot forge it, and neither can whoever runs the box.

**What to mirror.** Ask the package — it holds the verified list:

```bash
DATAMANCY_SITE=https://datamancy.dev npx -y datamancy@1 mirror
```

One path per line, ready to pipe: the manifest, its signature, the **current**
snapshot, and every spell body and blob.

**It lists the current version only** — that is the whole grimoire, and it is
what a live or pinned-to-current consumer needs. It is not the whole *origin*:
serve only these and your mirror has one version in its chain, so `datamancy
versions` truncates to that one (loudly) and `DATAMANCY_VERSION` resolves no
label but the current one. If you want older labels reachable, or a consumer
pins an older hash, copy those `/manifests/<hash>/` directories too. The shape
is:

```
/.well-known/mcp/manifest.json          the live manifest
/.well-known/mcp/manifest.json.sig      its detached ECDSA P-256 signature
/manifests/<hash>/manifest.json(.sig)   the snapshot(s) you intend to serve
/<spell>/SKILL.md  and  /blobs/sha256/  the spell bodies
```

Serve them **directly** — the kernel fetches with `redirect: "error"`, so a host
that 3xx-redirects to storage will fail every read. Static file hosting is the
whole requirement; there is nothing to run.

**Use `https`.** `DATAMANCY_SITE` accepts any scheme and the kernel does not
require one: integrity does not depend on the transport, because the signature
and the per-body hash carry it, and a plaintext origin cannot inject content. It
can still *withhold* — an on-path attacker on `http` can replay an older
authentically-signed manifest (the same lever the *What this defeats* table
grades `~`) and can observe which spells you read. `DATAMANCY_PIN` closes the
first; nothing closes the second but TLS.

**Configure it:**

```json
{
  "mcpServers": {
    "datamancy": {
      "command": "npx",
      "args": ["-y", "datamancy@1"],
      "env": {
        "DATAMANCY_SITE": "https://grimoire.corp.example",
        "DATAMANCY_PIN": "sha256:<manifest-hash>"
      }
    }
  }
}
```

**Get your mirror's own pin.** `current` honours `DATAMANCY_SITE`, so run it
against the mirror — the hash it prints is the one to pin, and it names the
origin it measured so there is no ambiguity:

```bash
DATAMANCY_SITE=https://grimoire.corp.example npx -y datamancy@1 current
```

**Set `DATAMANCY_PIN` too.** Rollback protection is per-session (see the
contract's *End-of-life*), so a fresh process accepts whatever `latest` it first
verifies. Without a pin, whoever controls the mirror can hold every consumer on
an old-but-authentically-signed manifest indefinitely, and nothing will complain
— the signatures are real. The pin is what makes a mirror you don't fully
control safe.

**A fully air-gapped host also needs the package vendored** — `npx` reaches the
registry at every launch, so it cannot work with no egress. On a connected
machine:

```bash
npm pack datamancy@1          # writes datamancy-<version>.tgz
```

copy that tarball across, then on the isolated host:

```bash
npm install -g ./datamancy-<version>.tgz
```

and point the client at the installed binary instead of `npx`:

```json
{ "command": "datamancy", "args": [] }
```

**Air-gapping actually holds.** Every `uri` and `blob` in a manifest must be
origin-relative — that is a MUST NEVER, refused as a shape error, not a
convention. A manifest carrying absolute URLs cannot load at all, so an isolated
network cannot be quietly walked back out to the public origin.

**If your mirror is slow,** raise `DATAMANCY_TIMEOUT_MS`. For manifests and
spell bodies an origin that exceeds the budget is not refused — the consumer
serves last-known-good, logs quietly, and tells the model so in-band on every
surface — so a mirror that routinely runs long stops tracking your edits without
alerting YOU, though never without the reader of the content being told. `datamancy versions` / `current` /
`mirror` and boot under `DATAMANCY_VERSION` have no fallback, so there the same
overrun is a hard failure.

## Trust model: living

The pinned **ECDSA P-256 public key** (`dist/pinned-pubkey.js` as installed;
`src/pinned-pubkey.ts` in the git source) is the anchor — the one value every
other guarantee is proved against. (What else is frozen: *What is frozen, and
what isn't*, below.) It verifies *any* manifest the matching private key signs —
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
verified copy exists, fetches are bounded by a ~5s backstop — the default; raise
it with `DATAMANCY_TIMEOUT_MS` — so a genuinely stuck fetch bails to
last-known-good rather than hanging.

## What this defeats

| Attack | Defended? |
|---|---|
| Tamper one spell file | ✓ Layer 1 (hash mismatch on fetch) |
| Tamper manifest + spell files together | ✓ Layer 2 (signature invalid) |
| Full website compromise + replace everything | ✓ Layer 2 (attacker lacks the non-exportable KMS private key) |
| Website-only compromise, *replay an old signed manifest* | ~ **in-session: refused** — the kernel rejects a `latest` whose signed `epoch` (a counter every manifest carries, which never decreases) regressed below the highest it verified this session — a loud refusal, never a silent revert. **Cross-restart / first-contact: accepted by design** — authentic but stale, low-stakes for a grimoire; a pinned consumer is immune (froze a known-good hash). |
| Website + KMS signing key both compromised | ✗ (the key is the anchor; it's non-exportable in KMS — protect the AWS account) |
| **npm / registry compromise** (a forged *package*, not forged content) | ~ Every release is published from GitHub Actions via tokenless OIDC with a [Sigstore provenance attestation](https://docs.npmjs.com/generating-provenance-statements) — `npm audit signatures` verifies it, and no long-lived publish token exists. Pin `datamancy@1` so a new major cannot arrive unannounced. |

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
- the practitioner identity card at [datamancer.dev](https://datamancer.dev),
  which publishes the same fingerprint under its datamancy section — the
  rendered page abbreviates it, so compare against
  [datamancer.dev/index.md](https://datamancer.dev/index.md), which carries all
  64 characters
- a DNS `TXT` record on separate infrastructure from npm, github, and the
  website. The record is a `key=value` pair; the hex after the `=` is the
  fingerprint, and it must equal the one above:
  ```bash
  dig +short TXT _datamancy-key.datamancer.dev
  # "datamancy-pubkey-sha256=09db7668a3a0ea27c52de060081c0a70584181c02f9eb94eff6941f904b5f12e"
  ```

If the key in your install doesn't match these, **do not trust it.**

Note the recipe above verifies an `npm install`ed copy; the `npx` MCP-config
install creates no local `node_modules`, so it is a *different* copy of the same
published tarball. To check the artifact itself, verify its provenance
attestation instead:

```bash
mkdir /tmp/check && cd /tmp/check && npm init -y >/dev/null
npm install datamancy@1
npm audit signatures
```

(There is no `--package` flag; `npm audit signatures` covers whatever is
installed, so an empty scratch project makes the answer about datamancy alone.)

## What is frozen, and what isn't

The **trust root** is frozen — the pinned key, the manifest format major, the
paths, the signature scheme, and the **tool wire shape** (the tool names and
their argument shapes, which every tools-only host is bound to). Those five are
what "frozen" means here; `CONTRACT.md` is normative. The kernel never needs
patching for the website to evolve, which is the point: edit a spell, re-sign,
push, done.

The *code* is not frozen, and earlier releases overstated this by saying
"published once and never patched." A release within a major may fix a defect or
add a protocol surface (`1.1.0` added the tool surface above); it may never move
the trust root. That is a new major, and a new major is why you pin `datamancy@1`. What the
website may evolve freely versus what would require a new major is the
**[forward-compatibility contract](CONTRACT.md)**, where every rule names the
test that fails if it is broken, or says `by construction` and why none is
possible. A
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
