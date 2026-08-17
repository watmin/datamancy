# RECOVERY — incident runbook

Two failure modes, and **neither is a consumer emergency**:

- **Compromise** — someone gains `kms:Sign` access *and* your hosting, and posts
  validly-signed malicious files. Recovery = remove the bad files + close the
  access. Same key, no version change, no consumer action — **unless** an
  attacker-signed snapshot may have circulated out of band, in which case the
  only full invalidation is a new major (step 2 below says how to tell). (Below.)
- **Loss** — the key becomes unavailable (account closed/locked-out, a KMS
  catastrophe, or deletion past the waiting period). You can no longer *sign*,
  but consumers are unharmed: they verify already-signed content against the
  pinned pubkey forever, and the grimoire simply freezes at its last-signed
  state. To *resume publishing* you provision a new key → a new pinned key → a
  new **major** (`datamancy 2.0.0`). **A new key generation always forces a new
  major** — `1.x` trusts this key, and the next key ships as a new major. The
  implication runs one way only: a major may also be minted for reasons that
  leave the key untouched (a manifest-format break, MCP capability-shape drift —
  see CONTRACT.md's *End-of-life*), so a new major does **not** by itself mean
  the key changed. There is no backup key and no in-major rotation — by
  deliberate design. (See *If the key is lost*, below.)

  **So on seeing a new major, check.** The release notes and the published
  fingerprint say whether the trust root moved; if it did, re-verify it through
  the independent channels in the README before trusting the new line.

The key lives in AWS KMS, non-exportable: the *material* can't be stolen, but
*access to it* can be abused (compromise) or *lost* (loss) — the two cases above.

## Facts you'll need

| | |
|---|---|
| AWS account | `312670213421` · region `us-west-2` |
| Key | `alias/datamancy-signing` — KeyId `5d291546-7379-4ed9-88a1-cbe45b9e86c2`, ECDSA P-256 |
| Signer (scoped, `kms:Sign` only) | SSO profile `datamancy-signer` — by design it **cannot** disable the key |
| Admin (to disable the key) | admin access to the account — the Console, or any session with `kms:DisableKey`. You'll know how to get it. |
| Channel | datamancy.dev = Cloudflare Pages ← GitHub `watmin/datamancy.dev` |
| Trust root (the key) | pinned pubkey in `datamancy/src/pinned-pubkey.ts` (shipped as `dist/pinned-pubkey.js`). The full frozen set is the key, the manifest format major, the paths, and the signature scheme — see CONTRACT.md; only the key has independent publication channels. |

## What an attacker can actually do

| They have… | Can sign? | Can serve? | Reaches consumers? |
|---|---|---|---|
| Hosting only (GitHub/Cloudflare) | ✗ | ✓ | **Partly.** Forged content: no — unsigned bytes are rejected by every consumer. But they need not forge anything: every past snapshot under `manifests/<hash>/` is already validly signed, so they can REPLAY an authentic older one. In-session that is refused (the monotone `epoch`); across a restart or on first contact it is accepted by design — see README's *What this defeats*. A pinned consumer is immune. |
| `kms:Sign` only (account breach) | ✓ | ✗ | **No** — they lack write access to the channel (Cloudflare/GitHub) |
| **Both** | ✓ | ✓ | **Yes** — a validly-signed malicious manifest. The only real case. |

And **pinned consumers** (`DATAMANCY_PIN=…`) are immune in every row — they
froze a known-good hash and never follow latest. There's nothing to recover for
them.

## Recovery (the "both compromised" case)

**1. Contain — halt signing instantly** (optional but fast). Console → KMS →
`datamancy-signing` → Disable; or:
```bash
aws kms disable-key --key-id alias/datamancy-signing \
  --region us-west-2 --profile <admin-profile>
```
The scoped signer role cannot disable the key, so this lever is always yours
(that's the point of least-privilege: a stolen signer credential can't cover its
tracks). Disabling does NOT affect consumers — they verify against the pinned
pubkey, not KMS.

- If the key is **scheduled for deletion** (an attacker move), cancel it — you
  have until the scheduled date.
- If you **can't authenticate as admin at all** (the breach took the account),
  you can't disable the key — lock the account through AWS and treat this as the
  *loss* path below; the key is out of your control.

**2. Clean — purge the malicious bytes from the channel.** This is the **content
repo** `github.com/watmin/datamancy.dev` (NOT the `datamancy` npm-package repo).
Date the bad publishes against your own records + the KMS `Sign` timeline
(CloudTrail, if KMS data-event logging is on — else compare commit authors/times).
```bash
cd datamancy.dev                  # content/channel repo — clone it if you must
git log --oneline -20             # find the commit(s) you did NOT publish
git revert <bad-commit> && git push   # keeps history, auditable; Cloudflare redeploys
#   (git reset --hard <last-good> && git push --force also works but REWRITES the live branch)
```
**Then delete the orphaned signed snapshots — the step a revert misses.** Every
published manifest is written *write-once* to `manifests/<hash>/`, and ANY
consumer can pin it forever via `DATAMANCY_PIN=sha256:<hash>`. Reverting the live
`manifest.json` removes the *pointer* but **leaves the attacker's snapshot
pinnable** by anyone who learned its hash. Delete every malicious snapshot dir
and confirm the chain no longer references it:
```bash
rm -rf manifests/<bad-hash>/                      # each malicious version
grep -rl <bad-hash> .well-known/mcp/ manifests/   # HEAD + previous-chain must come back clean
git add -A && git commit -m "purge malicious snapshots" && git push
```
A signed manifest can't be *un*-signed — the pinned key has no revocation.
Purging the channel protects default and live consumers; but if you have evidence
the attacker signed manifests they could circulate out of band (and trick someone
into `DATAMANCY_PIN`-ing the bad hash from another host), the *only* full
invalidation is a new major — `2.0.0` with a fresh key, the loss path below.

**3. Close — remediate the account** so they can't re-post. Rotate the
compromised AWS creds, kill bad SSO sessions, fix the hole they came through,
audit CloudTrail for what they did. Then re-enable the key and resume signing
normally:
```bash
aws kms enable-key --key-id alias/datamancy-signing \
  --region us-west-2 --profile <admin-profile>
```

**Verify the fix:** `npx -y datamancy current` against the live site reports your
last-good version and verifies clean, and a known malicious snapshot hash now
404s. Same key, same pinned pubkey, no republish, no consumer action. Done.

## If the key is lost (the line ends; a new major begins)

There is **no in-place recovery, by design** — no backup key to guard, no
rotation slot in the frozen kernel. The pinned pubkey is `1.0.0`'s one constant,
and a frozen kernel cannot un-pin it.

- **Consumers keep working.** Every already-signed manifest still verifies; the
  last-signed grimoire serves forever. Nothing to do for them.
- **You lose the ability to publish** — content freezes at its last-signed state
  until a new key exists.
- **To resume:** provision a fresh KMS key, ship `datamancy 2.0.0` pinning its
  pubkey, re-baseline the grimoire chain under it (fresh genesis), cross-publish
  the new fingerprint (git + datamancer.dev + DNS), and announce the new major so
  consumers re-source (`npx -y datamancy@2`). `1.x` consumers keep verifying the
  old frozen content; new content lives under `2.x`.
- **Telling `1.x` consumers — out of band, because you can't sign in-band.** With
  the `1.x` key gone you cannot push a signed `upgrade` notice into the `1.x`
  grimoire (any in-band message must be `1.x`-signed). Signal the deprecation
  where no key is needed: `npm deprecate datamancy@"^1.0.0" "datamancy 2.0
  released (rotated key); npm i datamancy@2"` — an npm-account action that warns
  on every `npx`/install and reaches the *operator* — plus the npm page, GitHub,
  and datamancer.dev. (A *planned* major, where the `1.x` key still lives, can
  additionally push a signed `upgrade` spell into the `1.x` grimoire — an
  in-band, LLM-facing notice. A lost key forecloses that path; the operator-level
  channels remain.)
- A genuine HSM-level key **compromise** (AWS attests the key material leaked —
  ≈never for a non-exportable KMS key) takes the same path: a new major, because
  the `1.x` pinned key can no longer be trusted and the frozen kernel can't drop
  it.

This is the deliberate cost of a never-patched, single-key trust root: lose the
key, lose the line — but never the consumers, and never silently.

## What recovery (from compromise) is NOT

- **Not key rotation.** A compromise of *access* is temporary `kms:Sign`
  permission, not a stolen secret. Fix the access, keep the key, no version
  change. (Three things ARE different and do take the new-major path: a genuinely
  **lost** key, an HSM-level compromise, and — per step 2 — an access compromise
  where attacker-signed snapshots may have escaped out of band, since a hash
  someone already holds cannot be purged by deleting it from your host.)
- **Not republishing the npm package.** The pinned pubkey is unchanged. (A
  package republish is for a kernel change, which is a separate axis entirely —
  see CONTRACT.md's *What a package minor may change*.)
- **Not a consumer action.** Live consumers heal on their next fetch; pinned
  consumers were never exposed.
