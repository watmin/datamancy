# datamancy v1.1.0 — the tool surface

**Additive. The trust root does not move.** Same pinned ECDSA P-256 key, same
manifest format major, same paths, same signature scheme. A `1.0.0` consumer and
a `1.1.0` consumer read the same signed grimoire and verify it identically.

## Why

MCP defines two ways for a server to expose content: **resources** (a catalog a
user browses) and **tools** (verbs a model calls). A library of documents is
honestly a resources server, and `1.0.0` was exactly that.

But many hosts only wire *tools* through to the model — and several call
`tools/list` unconditionally at startup, then treat the spec-correct
`-32601 Method not found` as a dead server. Measured against Grok Build 1.0.4:
handshake OK, resources served fine, `mcp doctor` reported the server as
failing. The server was right and the host was sloppy, and the grimoire was
unreachable either way.

So `1.1.0` grows a second mouth on the same pipeline.

## What's new

**Two tools, one catalog.**

| tool | arguments | returns |
|---|---|---|
| `list_spells` | none | every spell's short name + description, from the live signed manifest |
| `fetch_spell` | `{"spell": "<short-name>"}` | that spell's verified markdown |

Both resolve against the same manifest `resources/list` reads and run the same
verification — ECDSA P-256 on the manifest, SHA-256 + size + UTF-8 on the body.
`fetch_spell` returns bytes identical to `resources/read` for the same spell.
There is no per-spell branch and no second catalog: a spell added to the website
is a new manifest row, visible with no package change.

`tools/list` no longer returns `-32601`. `resources/list` and `resources/read`
are unchanged.

**A last-known-good body is now labelled — on every surface.** When the origin
fails and the kernel serves previously-verified content, `resources/list`,
`resources/read`, and both tools all say so in-band. Previously that fact
reached only stderr — which the model never reads — so stale content arrived
indistinguishable from fresh. The resources half was the harder one: the
catalog's notice used to ride on the description *fallback*, so it appeared only
on rows that had no description — and every row of a real manifest has one. It
could not fire against the live origin at all.

**JSON-RPC batches work.** MCP `2025-03-26` permits them and this server echoes
that version back, but the framing layer rejected arrays: a two-request batch got
one `-32600` and both requests hung forever. Now dispatched and answered as an
array.

**Client faults carry `-32602`.** An unknown tool or a malformed argument was
reported as `-32603 Internal error` — telling the client the server broke when
the request was wrong. Error responses also no longer carry a stack trace, which
leaked the absolute install path (under `npx`, the OS username) onto a channel
hosts surface into model context.

**`DATAMANCY_TIMEOUT_MS`** raises the fetch budget for a self-hosted origin
slower than the public one. Every fetch is now bounded — `datamancy current`,
`datamancy versions`, and boot under `DATAMANCY_VERSION` previously had no
timeout at all and would hang indefinitely against an origin that accepted the
connection and never answered.

**`datamancy --version`**, and an unrecognised argument now prints help and exits
instead of silently booting a server that blocks on stdin.

## Hardened

Three manifest rules became structural refusals rather than stated intentions:

- **`uri` and `blob` must be origin-relative.** An absolute reference was a
  well-formed manifest that silently escaped `DATAMANCY_SITE` — an air-gapped
  mirror would reach back out to the public origin, report the bytes as
  verified, and log nothing. Now a shape error.
- **Resource names must be unique.** `name` addresses a spell now, so duplicates
  made array *position* decide which bytes a caller received, while the contract
  permits reordering freely.
- **`description` must be a string** if present. It renders into the catalog a
  model reads.

## The contract and the docs

`CONTRACT.md` now covers the tool surface in both normative lists and in the
end-of-life clause, and — more importantly — **all 24 rules now name the test that
enforces it, or say `by construction` and why none is possible.** Two of them
carry `by construction`, each with its reason stated inline; the other 22 cite a
test file that exists in the git source, and every one of those 22 is
mutation-verified by `scripts/verify-contract-marks.mjs` — which
`test/contract-marks.test.mjs` now cross-references against the document itself,
so a marked rule with no mutation is a red test rather than a matching count. The blanket "enforced by
tests" claim was false: roughly a third of the rules had nothing behind them.
The worst was the one promising *"the signature is always required and verified
regardless of what `signed` says"* — deleting the signature check under
`trust.signed: false` left the whole suite green and accepted a manifest whose
signature was the literal bytes `GARBAGE`. That rule, and the other unenforced
ones, now have tests that go red when the guard is removed.

`README.md` gains the tool surface, a self-hosting section that can actually be
executed (what to mirror, why to also pin, why air-gapping holds), and a row for
the npm channel itself — which carries the pinned key and had no row.

**"Published once and never patched" is retired.** It was the aspiration, and
`1.1.0` is the counterexample. What is actually frozen is the trust root: the
key, the format major, the paths, the signature scheme — and, as of this
release, the tool wire shape, which a tools-only host now depends on. The kernel never needs
patching for the *website* to evolve — that is the guarantee, and it still holds.

## A note for air-gapped installs

`npx -y datamancy@1` resolves against the npm registry **on every launch**, so
it does not work on a host with no egress. Self-hosting the grimoire
(`DATAMANCY_SITE`) solves the *content* half; the *package* half needs the
tarball vendored:

```bash
npm pack datamancy@1                       # on a connected machine
# copy datamancy-1.1.0.tgz to the isolated host, then:
npm install -g ./datamancy-1.1.0.tgz
```

and point the client at the installed binary instead of `npx`:

```json
{ "command": "datamancy", "args": [] }
```

`datamancy mirror` prints every path your mirror must serve, for the origin
currently configured.

## Upgrading

Nothing to do; the change is additive. But **pin the major**:

```json
"args": ["-y", "datamancy@1"]
```

A bare `datamancy` resolves against the registry on every launch, so a release
changes what your client runs — including which MCP capabilities it advertises —
without you touching the config. `@1` still takes fixes within the major and
never silently crosses a trust-root change.
