# The Forward-Compatibility Contract

This package is built to be **published once and never patched.** The pinned
public key (`src/pinned-pubkey.ts`) is the only constant; the website is the
content. The promise — *"we manage markdown files and nothing else"* — only
holds if the frozen kernel can consume every reasonable future evolution of
`datamancy.dev` without a code change.

This document is that boundary, made explicit and **enforced by tests**
(`test/forward-compat.test.mjs`, `http.test.mjs`, `chain.test.mjs`, `ssrf.test.mjs`,
and the rest of `npm test`). It is the
rulebook the markdown-managers live by. Two lists: what the website **MAY**
change freely, and what it **MUST NEVER** change without minting a new major.

Everything here is empirically verified against the shipped `dist/` kernel.

---

## The kernel's understanding

- It understands manifest **format major `1`** (`KERNEL_SCHEMA_MAJOR`).
- It verifies every manifest with **ECDSA P-256 over SHA-256** against the
  pinned key, and every spell body against the manifest's **SHA-256 + size**.
- It ships spell bodies as **UTF-8 text** only.
- It speaks MCP and will **echo** any protocol version in its serviceable set
  (`2024-11-05`, `2025-03-26`, `2025-06-18`), else offer its default.

---

## The website MAY change these freely — the frozen kernel tolerates them

Most are proven by a test; items 8–9 (scale, chain termination) are guaranteed
by construction — the kernel never counts resources or inspects `mimeType`, and
the content-addressed chain makes cycles infeasible. An already-installed v1
client keeps working.

1. **Edit any spell's content.** New SHA-256 + size in the manifest, re-sign,
   push. This is the everyday path — the whole point.
2. **Add or remove spells.** A live session is nudged (`list_changed`) to
   re-source the grimoire at point of use.
3. **Add unknown top-level manifest fields** (`categories`, `metadata`, …).
4. **Add unknown fields to `serverInfo`** (`homepage`, `contact`, …).
5. **Add unknown fields to `trust`** (`custodian`, `rotated`, …). `tier` and
   `signed` are decorative metadata — the signature is *always* required and
   verified regardless of what `signed` says.
6. **Add unknown fields to any resource** (`tags`, `deprecated`, `weight`, …).
7. **Reorder resources.** Lookup is by name / uri, never by position.
8. **Scale the catalog** — hundreds of spells, long descriptions, any
   `mimeType` string (it is never inspected; bodies are still UTF-8 text).
9. **Publish a long version chain.** The walk is iterative and each hop is
   hash-asserted; cycles are cryptographically impossible. *Label discovery is
   bounded* — `versions` lists the 50 most recent and `DATAMANCY_VERSION`
   resolves a label within the 100 most recent (a frozen client must not walk
   unbounded history at boot) — but **any** version, however old, is always
   reachable by exact hash pin (`DATAMANCY_PIN`), which fetches one immutable
   snapshot directly.
10. **Self-host.** Manifest paths are origin-relative; an org may clone a
    snapshot and serve it from its own host (`DATAMANCY_SITE`). The pinned key
    still proves the content — they host the bytes but cannot forge them.

## The website MUST NEVER change these under schemaVersion 1

Doing so corrupts or bricks every already-installed v1 client that can never
be patched. Each is a hard refusal in the kernel (a loud, verification-class
rejection) — never a silent misread.

1. **`trust.algorithm` must stay `"SHA-256"`.** The kernel can only compute
   SHA-256; any other value is refused. **Crypto agility requires a new major
   (a new package), not an in-place change.** (See *End-of-life*, below.)
2. **The required shapes are frozen.** `trust` must remain
   `{ algorithm:"SHA-256", tier:number, signed:boolean }`; `serverInfo` must
   remain `{ name:string, version:string }` (extras OK); `resources` must
   remain a JSON **array**. Dropping or retyping any of these → refusal.
3. **Every resource must keep** `name:string`, `uri:` (URL-resolvable string),
   `blob:` (URL-resolvable content-address — **required**, never omitted, or a
   pinned read would silently fetch the mutable `uri`), `mimeType:string`,
   `sha256:` (64 **lowercase** hex), `size:` (finite, `0 ≤ size ≤ 16 MiB`).
   Renaming `sha256`→`digest`, dropping `size`/`blob`, or an uppercase/short
   hash → refusal. (`description` is the one optional resource field.)
3a. **Every manifest must DECLARE — never imply by omission** — `schemaVersion`
   (number), `previous` (a content-address string, or `null` at genesis, but
   the field MUST be present), and `epoch` (a finite number ≥ 0). These are not
   optional: an absent `epoch` would bypass rollback protection, an absent
   `schemaVersion` would be silently assumed to be major 1, and an absent
   `previous` would make the chain root ambiguous. Omitting any → refusal.
3b. **`epoch` MUST NOT regress across published `latest` manifests.** The
   consumer refuses a live `latest` whose `epoch` dropped below the highest it
   verified this session (rollback protection); an *equal* epoch is accepted (a
   same-second re-publish). The generator goes further and makes each publish
   *strictly* increase (`epoch = max(now, prevEpoch + 1)`); a publisher must
   never hand-author a decreasing epoch.
4. **Field *meaning* is frozen.** `sha256` is over the *exact bytes served*;
   `size` is those bytes' length; the body is **UTF-8 text**. You may not
   overload an existing field (e.g. make `sha256` mean "hash of the compressed
   bytes"). A semantic change is a breaking change — see below.
5. **Spell bodies must be valid UTF-8 text.** A binary / non-UTF-8 body is
   refused loud (`EncodingError`), never shipped as mojibake. **No binary
   spells under v1.**
5a. **Spell bodies must be ≤ 16 MiB** (`MAX_RESOURCE_BYTES`). This is a memory
   backstop, not a content policy — a markdown spell is a few KB, so the ceiling
   is ~1700× any real spell. A manifest declaring a larger `size` is refused.
   It exists so *every* content read is bounded, at every trust level.
6. **The paths and signature scheme are frozen.** Live manifest at
   `/.well-known/mcp/manifest.json`; snapshots at
   `/manifests/<hash>/manifest.json`; detached DER signature at
   `…/manifest.json.sig`; signed by the pinned P-256 key.
7. **`previous` must be `null` (genesis) or exactly `sha256:<64-lowercase-hex>`,
   and its target bytes must hash to it.** The kernel shape-gates the format
   (not merely "a string") so a garbage backpointer can't be interpolated into a
   fetch URL, and rejects a non-matching target (tamper-evident chain).
8. **The origin must serve manifest, signature, and content DIRECTLY — no 3xx
   redirects.** The kernel fetches with `redirect: "error"`: a redirect is
   refused, because following one would let a hosting-only attacker turn the
   kernel into an SSRF request-forwarder (an attacker-chosen outbound request
   before any verification). Self-hosters and mirrors must serve directly too.

---

## How to ship a breaking change (the escape hatch)

`schemaVersion` is the publisher's break signal. The frozen v1 kernel
**refuses any `schemaVersion` greater than `1`, loudly** ("upgrade the
datamancy package") rather than guessing at a format it predates. So:

- **Additive change?** Don't bump `schemaVersion`. Old clients tolerate it.
- **Breaking change** (retire a field's meaning, change the digest, ship
  binary, move a path)? **Bump `schemaVersion` to ≥ 2 AND mint a new package
  major.** Old clients then fail *loud and safe* — they refuse the new manifest
  and tell the operator to upgrade, instead of silently misreading it. New
  clients understand the new major.

This is what keeps "never patch the kernel" honest: a breaking change isn't a
patch to v1, it's a *new* frozen kernel alongside it.

---

## End-of-life conditions (inherent, documented bounds)

A frozen kernel + a pinned key cannot absorb these. They are the honest cost of
the design, not bugs:

- **Crypto deprecation.** The day SHA-256 or P-256 is deprecated, **v1.0.0 is
  end-of-life by design.** A new package signs and verifies under the new
  primitive. No in-place migration is possible (it would defeat the pin).
- **MCP capability-shape drift.** The protocol-version *echo* absorbs version
  bumps, but if a future MCP revision changes the *shape* of the `resources`
  capability or the read envelope, that is a new-major event. The serviceable
  set in `src/mcp.ts` is the explicit compatibility bound.
- **Node platform drift.** Every runtime API used is warning-free and
  behaviourally stable at the `engines` floor (Node ≥ 20), verified empirically
  Node 20.0.0 → 24.x. (Global `fetch` and Web Streams carry an "experimental"
  API-surface label until Node 21, but on Node 20 they run warning-free and
  unchanged — confirmed by running the floor, not just Node 24.) A far-future
  Node removing a stdlib API is outside any frozen artifact's control.
- **Rollback protection is per-session, by design.** The kernel refuses a live
  `latest` whose `epoch` regressed below the highest it verified *this process
  lifetime* — so a long-lived session cannot be silently reverted. It does NOT
  persist a high-water mark across restarts: a fresh process has no baseline and
  accepts whatever `latest` it first verifies. Closing the cross-restart window
  would require persisted local state (poisonable → a self-inflicted false-reject
  class) or publisher heartbeat-signing (breaks "publish once, edit-on-change").
  For a markdown grimoire neither trade is worth it; the in-session bound is
  deliberate, not an oversight.

---

*If a desired change isn't on the MAY list, it is breaking. Mint a new major.*
