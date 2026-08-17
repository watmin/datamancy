# The Forward-Compatibility Contract

The **trust root is frozen, and the kernel never needs patching for the website
to evolve.** The pinned public key (`dist/pinned-pubkey.js` as installed;
`src/pinned-pubkey.ts` in the [git source](https://github.com/watmin/datamancy))
is the anchor; the website is the content. (It is not the *only* invariant —
the four named below are — but it is the one everything else is proved against.) The promise — *"we manage
markdown files and nothing else"* — only holds if the frozen kernel can consume
every reasonable future evolution of `datamancy.dev` without a code change.

**What a package minor may change.** Earlier releases said "published once and
never patched." That was the aspiration, and it was not honest about what a
minor is for: `1.1.0` added an MCP *tool* surface without touching the trust
root. So state the rule instead of the wish. Within a major, a release MAY add a
protocol surface, fix a defect, or tighten a check — and MUST NOT change the
pinned key, the manifest format major, the paths, or the signature scheme —
nor the tool wire shape (MUST NEVER 11), which every tools-only host is bound
to. Those five are what "frozen" means here. Anything touching them is a new major
(*End-of-life*, below).

This document is that boundary, made explicit. It is the rulebook the
markdown-managers live by. Two lists: what the website **MAY** change freely,
and what it **MUST NEVER** change without minting a new major.

**How much of it is enforced, precisely.** Every rule below is marked with the
test that fails if the rule is broken, or with **`by construction`** and the
reason no test is possible. Those marks are the claim — not a blanket "enforced
by tests," which this document carried for a release while a third of its rules
had nothing behind them. The suite is `npm test`; test paths refer to the
[git source](https://github.com/watmin/datamancy), which is not in the npm
tarball. Tests run against the shipped `dist/` kernel (`pretest` rebuilds it),
so what they check is what you install.

A rule marked with a test has been verified the only way that means anything:
the guard was **deleted** and that test went red. A rule that passes with and
without its guard is not enforced, whatever the file says.

That verification is a script, not a promise — `scripts/verify-contract-marks.mjs`
in the [git source](https://github.com/watmin/datamancy) mutates each guard and
fails if a cited test stays green. It exists because these marks were first
hand-written from reading and several were wrong, including the no-redirect rule,
which cited two files that do not enforce it while the one that does went
unnamed. Re-run it whenever a mark changes.

---

## The kernel's understanding

- It understands manifest **format major `1`** (`KERNEL_SCHEMA_MAJOR`).
- It speaks **two MCP surfaces over one pipeline**: `resources` (list + read)
  and `tools` (`list_spells`, `fetch_spell`). Both resolve against the same
  signed manifest and run the same verification; the tools exist because many
  hosts wire only tools through to the model. Neither is a second catalog.
- It verifies every manifest with **ECDSA P-256 over SHA-256** against the
  pinned key, and every spell body against the manifest's **SHA-256 + size**.
- It ships spell bodies as **UTF-8 text** only.
- It speaks MCP and will **echo** any protocol version in its serviceable set
  (`2024-11-05`, `2025-03-26`, `2025-06-18`), else offer its default.

---

## The website MAY change these freely — the frozen kernel tolerates them

Most are proven by a test; item 8 (scale) is guaranteed by construction — the
kernel never *bounds* the resource count and never inspects `mimeType`, and the
content-addressed chain makes cycles infeasible. Item 9's two numeric bounds are
proven by test, not by construction — see its own mark. An already-installed v1
client keeps working.

1. **Edit any spell's content.** New SHA-256 + size in the manifest, re-sign,
   push. This is the everyday path — the whole point.
   *(`test/grimoire-trust.test.mjs`, `test/tools.test.mjs` — only verified bytes are ever remembered, so an edit propagates on the next read.)*
2. **Add or remove spells.** A live session is nudged (`list_changed`) to
   re-source the grimoire at point of use.
   *(`test/listchange.test.mjs`, `test/tools.test.mjs` — the two that go red when the set-diff is suppressed; `setchange` and `handlers` exercise the diff function and the nudge wiring, but neither fails on its own if the diff stops firing.)*
3. **Add unknown top-level manifest fields** (`categories`, `metadata`, …).
   *(`test/forward-compat.test.mjs`.)*
4. **Add unknown fields to `serverInfo`** (`homepage`, `contact`, …).
   *(`test/forward-compat.test.mjs`.)*
5. **Add unknown fields to `trust`** (`custodian`, `rotated`, …). `tier` and
   `signed` are decorative metadata — the signature is *always* required and
   verified regardless of what `signed` says.
   *(`test/forward-compat.test.mjs` for the unknown fields; `test/contract.test.mjs` for the always-verify half — it serves a `signed:false` manifest with a garbage signature and requires refusal.)*
6. **Add unknown fields to any resource** (`tags`, `deprecated`, `weight`, …).
   *(`test/forward-compat.test.mjs`.)*
7. **Reorder resources.** Lookup is by name / uri, never by position.
   *(`test/contract.test.mjs` — the same two resources in both orders must resolve identically by name AND by uri.)*
8. **Scale the catalog** — hundreds of spells, long descriptions, any
   `mimeType` string (it is never inspected; bodies are still UTF-8 text).
   *(**by construction** — the kernel never *bounds* the resource count (it does count them, for `datamancy current` and the boot log) and never inspects `mimeType`. There is no limit in the code to test against.)*
9. **Publish a long version chain.** The walk is iterative and each hop is
   hash-asserted; cycles are cryptographically impossible. *Label discovery is
   bounded* — `versions` lists the 50 most recent and `DATAMANCY_VERSION`
   resolves a label within the 100 most recent (a frozen client must not walk
   unbounded history at boot) — but **any** version, however old, is always
   reachable by exact hash pin (`DATAMANCY_PIN`), which fetches one immutable
   snapshot directly.
   A chain with a **dangling backpointer** (a `previous` naming a snapshot the
   origin no longer serves) does not brick the listing: `versions` returns every
   hop that verified above the break and says loudly that the chain is broken
   there. Two failures are never truncated — a verification failure mid-walk (a
   tamper is not answerable with a short list) and a failure on the first hop
   (there is no partial answer, and "unreachable" must not read as "no versions
   exist"). `DATAMANCY_VERSION` does **not** truncate at all: a walk that
   stopped early has not proven a label absent.
   *(`test/chain.test.mjs` for the walk, its hash-assertions, the truncation and
   both of its exceptions; `test/contract.test.mjs` for the 50 and 100 bounds.)*
10. **Self-host.** An org may clone a snapshot and serve it from its own host
    (`DATAMANCY_SITE`). The pinned key still proves the content — they host the
    bytes but cannot forge them. Origin-relativity is not a courtesy here, it is
    what makes the mirror airtight, so it is a MUST NEVER (item 9 below), not a
    hope. *(`test/contract.test.mjs`, `test/resilience.test.mjs`.)*

    **A self-hosted mirror should also pin.** `DATAMANCY_SITE` alone lets
    whoever controls the mirror hold you on an old-but-authentically-signed
    manifest indefinitely — rollback protection is per-session (*End-of-life*,
    below), so a restart accepts whatever `latest` it first verifies. Set
    `DATAMANCY_PIN` too. If the mirror is slower than the public origin (a VPN
    or auth proxy), raise `DATAMANCY_TIMEOUT_MS`; the default budget is 15 s
    cold / 5 s warm, and a mirror that exceeds it serves last-known-good —
    quietly on stderr, but **disclosed in-band to the model** on every
    surface.

## The website MUST NEVER change these under schemaVersion 1

Doing so corrupts or bricks every already-installed client that can never be
patched — with one honest caveat: items 9 and 10 are gates that landed in
`1.1.0`, so a `1.0.x` client does not have them and will follow an absolute
`uri` happily. They bind the website from `1.1.0` onward.

Item 11 is the odd one out and is listed here for proximity, not because it
binds the website: it constrains **this package**, not the origin, and it is the
one MUST NEVER a release could violate rather than a publisher.

Items 1–5a, 7, 9, 10 are **verification-class** refusals — loud, never a silent
misread. Items 6 and 8 (a moved path, a redirecting origin) are
**transport-class**: the fetch simply fails, and a session holding a verified
memo serves last-known-good with a *quiet* log rather than the loud
verification-failure banner. That difference is real and worth knowing — but it
is a difference in the OPERATOR's log register only. Both classes are disclosed
identically to the MODEL: any last-known-good serving carries the staleness
notice on `resources/list`, `resources/read`, and both tools. Nothing degrades
silently to the reader of the content.

1. **`trust.algorithm` must stay `"SHA-256"`.** The kernel can only compute
   SHA-256; any other value is refused. **Crypto agility requires a new major
   (a new package), not an in-place change.** (See *End-of-life*, below.)
   *(`test/contract.test.mjs`, `test/forward-compat.test.mjs`.)*
2. **The required shapes are frozen.** `trust` must remain
   `{ algorithm:"SHA-256", tier:number, signed:boolean }`; `serverInfo` must
   remain `{ name:string, version:string }` (extras OK); `resources` must
   remain a JSON **array**. Dropping or retyping any of these → refusal.
   *(`test/contract.test.mjs` — each field dropped and retyped individually.)*
3. **Every resource must keep** `name:string`, `uri:` (URL-resolvable string),
   `blob:` (URL-resolvable content-address — **required**, never omitted, or a
   pinned read would silently fetch the mutable `uri`), `mimeType:string`,
   `sha256:` (64 **lowercase** hex), `size:` (finite, `0 ≤ size ≤ 16 MiB`).
   Renaming `sha256`→`digest`, dropping `size`/`blob`, or an uppercase/short
   hash → refusal. (`description` is the one optional resource field — optional, but **typed**: a
   non-string `description` is refused, because it renders verbatim into the
   catalog `list_spells` hands a model.)
   *(`test/contract.test.mjs` — every field dropped, retyped, and boundary-tested.)*
3a. **Every manifest must DECLARE — never imply by omission** — `schemaVersion`
   (number), `previous` (a content-address string, or `null` at genesis, but
   the field MUST be present), and `epoch` (a finite number ≥ 0). These are not
   optional: an absent `epoch` would bypass rollback protection, an absent
   `schemaVersion` would be silently assumed to be major 1, and an absent
   `previous` would make the chain root ambiguous. Omitting any → refusal.
   *(`test/forward-compat.test.mjs`.)*
3b. **`epoch` MUST NOT regress across published `latest` manifests.** The
   consumer refuses a live `latest` whose `epoch` dropped below the highest it
   verified this session (rollback protection); an *equal* epoch is accepted (a
   same-second re-publish). The generator goes further and makes each publish
   *strictly* increase (`epoch = max(now, prevEpoch + 1)`); a publisher must
   never hand-author a decreasing epoch.
   *(`test/rollback.test.mjs`.)*
4. **Field *meaning* is frozen.** `sha256` is over the *exact bytes served*;
   `size` is those bytes' length; the body is **UTF-8 text**. You may not
   overload an existing field (e.g. make `sha256` mean "hash of the compressed
   bytes"). A semantic change is a breaking change — see below.
   *(**by construction** — a rule about what a value MEANS. No test can tell a correct SHA-256 from one the publisher computed correctly over the wrong bytes; only the publisher can honour this.)*
5. **Spell bodies must be valid UTF-8 text.** A binary / non-UTF-8 body is
   refused loud (`EncodingError`), never shipped as mojibake. **No binary
   spells under v1.**
   *(`test/http.test.mjs`.)*
5a. **Spell bodies must be ≤ 16 MiB** (`MAX_RESOURCE_BYTES`). This is a memory
   backstop, not a content policy — a markdown spell is a few KB, so the ceiling
   is ~1700× any real spell. A manifest declaring a larger `size` is refused.
   It exists so *every* content read is bounded, at every trust level.
   *(`test/contract.test.mjs`, `test/forward-compat.test.mjs`.)*
6. **The paths and signature scheme are frozen.** Live manifest at
   `/.well-known/mcp/manifest.json`; snapshots at
   `/manifests/<hash>/manifest.json`; detached DER signature at
   `…/manifest.json.sig`; signed by the pinned P-256 key.
   *(`test/contract.test.mjs` — hermetic, asserting the exact URLs fetched; also `test/integration.test.mjs` and `test/process.test.mjs` against the live origin.)*
7. **`previous` must be `null` (genesis) or exactly `sha256:<64-lowercase-hex>`,
   and its target bytes must hash to it.** The kernel shape-gates the format
   (not merely "a string") so a garbage backpointer can't be interpolated into a
   fetch URL, and rejects a non-matching target (tamper-evident chain).
   *(`test/forward-compat.test.mjs`, `test/chain.test.mjs`.)*
8. **The origin must serve manifest, signature, and content DIRECTLY — no 3xx
   redirects.** The kernel fetches with `redirect: "error"`: a redirect is
   refused, because following one would let a hosting-only attacker turn the
   kernel into an SSRF request-forwarder (an attacker-chosen outbound request
   before any verification). Self-hosters and mirrors must serve directly too.
   *(`test/ssrf.test.mjs` — every trust-path fetch asserted to pass
   `redirect:"error"`. That is the ONLY file enforcing this rule; it was briefly
   marked with two others that stay green when the guard is removed, which is
   why the marks are now script-verified.)*

9. **`uri` and `blob` must be ORIGIN-RELATIVE.** No scheme, no authority —
   `spell/SKILL.md` and `/blobs/sha256/<hash>`, never `https://…`. An absolute
   reference is a well-formed manifest that silently escapes `DATAMANCY_SITE`:
   an operator who air-gapped on purpose reaches back out to the public origin,
   with the bytes still reported as verified and nothing logged. Refused as a
   shape error. *(`test/contract.test.mjs`.)*

10. **Resource `name`s must be UNIQUE within a manifest.** `name` addresses a
   spell (`fetch_spell` resolves by it), so duplicates would make array
   *position* decide which bytes a caller receives — while MAY item 7 permits
   reordering freely. Both cannot be true; duplicates are refused.
   *(`test/contract.test.mjs`.)*

11. **The tool wire shape is frozen.** The tool NAMES (`list_spells`,
   `fetch_spell`), `fetch_spell`'s argument name (`spell`), and the
   `{content:[{type:"text",text}], isError?}` envelope are a permanent contract
   for every tools-only host. Renaming one bricks them exactly as renaming a
   manifest field bricks a reader. *(`test/tools.test.mjs`.)*

---

## How to ship a breaking change (the escape hatch)

`schemaVersion` is the publisher's break signal. The frozen v1 kernel
**refuses any `schemaVersion` greater than `1`, loudly** ("upgrade the
datamancy package") rather than guessing at a format it predates. So:

*(`test/forward-compat.test.mjs` — a `schemaVersion` above the kernel's major
is refused with a distinct, loud error class, not a shape error. Mutation-
verified as `break signal` in `scripts/verify-contract-marks.mjs`.)*

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

- **Crypto deprecation.** The day SHA-256 or P-256 is deprecated, the whole
  **`1.x` line is end-of-life by design.** A new package signs and verifies under the new
  primitive. No in-place migration is possible (it would defeat the pin).
- **MCP capability-shape drift.** The protocol-version *echo* absorbs version
  bumps, but if a future MCP revision changes the *shape* of the `resources`
  capability, the read envelope, the `tools` capability, the tool descriptor, or
  the `CallToolResult` envelope, that is a new-major event. The serviceable set
  in `src/mcp.ts` is the explicit compatibility bound. (`1.x` serves
  `2024-11-05`, `2025-03-26` — including JSON-RPC batches — and `2025-06-18`.)
- **Node platform drift.** Every runtime API used is warning-free and
  behaviourally stable at the `engines` floor (Node ≥ 20). CI runs the suite on
  Node **20 and 22** — both ends of the declared `engines` range — with
  `DATAMANCY_REQUIRE_NETWORK=1`, and that run is the publish gate. Only the
  22 → 24.x span remains hand-confirmed at freeze time with **no artifact
  reproducing it** — treat that upper span as a recorded observation, not a
  standing guarantee. (Global `fetch` and Web Streams carry an "experimental"
  API-surface label until Node 21, but on Node 20 they run warning-free.) A far-future
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

## Timeouts — what an origin must meet

The kernel bounds every fetch: **15 s** with no fallback available, **5 s** once
a verified copy exists, and one shared budget for the whole version walk and the
CLI. For a manifest or a spell body, an origin slower than that is not refused — the
consumer serves last-known-good and logs quietly — and tells the model so
in-band on every surface — so a mirror that routinely exceeds it stops tracking
your edits without the OPERATOR being alerted, though never without the reader
of the content being told.

**The version walk is different: it has nothing to fall back to.** `datamancy
versions`, `datamancy current`, `datamancy mirror`, and boot under
`DATAMANCY_VERSION` all run before any manifest is memoised, so an overrun there
is a hard failure, not a quiet degrade. That one budget covers the WHOLE walk —
up to 50 hops for `versions`, up to 100 for a `DATAMANCY_VERSION` label — so a
deep label against a high-latency mirror needs `DATAMANCY_TIMEOUT_MS` raised,
not merely tolerated.

`DATAMANCY_TIMEOUT_MS` **sets** the cold budget; it does not merely raise it, so
`2000` *lowers* the 15 s default to 2 s. The warm bound is **derived**, not
independent: `round(cold × 5000/15000)`, floored at 1 s — so `60000` gives
20 s warm, and `3000` gives 1 s (the floor). Values are clamped to `[1000, 2147483647]`
(the upper bound is what `AbortSignal.timeout` can express; above it the host
wraps the delay to ~1 ms, which would make a larger request produce a smaller
budget). An unparseable value falls back to the defaults.

*(`test/timeout.test.mjs` — every number above is one of its assertions: the
defaults, the derivation and its floor, both clamp edges, the monotonicity the
clamp exists to guarantee, that every trust-path fetch carries a signal, and
that the walk shares ONE deadline. Four of these are mutation-verified in
`scripts/verify-contract-marks.mjs`.)*

---

*If a desired change isn't on the MAY list, it is breaking. Mint a new major.*
