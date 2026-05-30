# RECOVERY — incident runbook

The short version: **there is no key recovery here, because the key can't be
lost.** It lives in AWS KMS and is non-exportable. The only thing an attacker
can do is leave *validly-signed malicious files on the channel* — and only if
they compromised your AWS account (to sign) **and** your hosting (to serve).
So recovery is just: **remove the bad files, and close the access that let them
be posted.**

## Facts you'll need

| | |
|---|---|
| AWS account | `312670213421` · region `us-west-2` |
| Key | `alias/datamancy-signing` — KeyId `5d291546-7379-4ed9-88a1-cbe45b9e86c2`, ECDSA P-256 |
| Signer (scoped, `kms:Sign` only) | SSO profile `datamancy-signer` |
| Admin (can disable the key) | a `PowerUserAccess` SSO session |
| Channel | datamancy.dev = Cloudflare Pages ← GitHub `watmin/datamancy.dev` |
| Trust root | pinned pubkey in `datamancy/src/pinned-pubkey.ts` |

## What an attacker can actually do

| They have… | Can sign? | Can serve? | Reaches consumers? |
|---|---|---|---|
| Hosting only (GitHub/Cloudflare) | ✗ | ✓ | **No** — unsigned content is rejected by every consumer |
| `kms:Sign` only (account breach) | ✓ | ✗ | **No** — never served from datamancy.dev |
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
The scoped signer role cannot disable the key, so this lever is always yours.
Disabling does NOT affect consumers — they verify against the pinned pubkey,
not KMS.

**2. Clean — delete the malicious files** (this is the actual recovery). Revert
the channel to the last known-good bytes, which are already signed and sitting
in git history:
```bash
cd datamancy.dev
git revert <bad-commit>            # or: git reset --hard <good-commit> && force-push
git push                            # Cloudflare redeploys; live consumers get good content next fetch
```

**3. Close — remediate the account** so they can't re-post. Rotate the
compromised AWS creds, kill bad SSO sessions, fix the hole they came through,
audit CloudTrail for what they did. Then re-enable the key and resume signing
normally:
```bash
aws kms enable-key --key-id alias/datamancy-signing \
  --region us-west-2 --profile <admin-profile>
```

Same key, same pinned pubkey, no republish, no consumer action. Done.

## What recovery is NOT

- **Not key rotation.** The key material was never exposed; a compromise is
  temporary `kms:Sign` *access*, not a stolen secret. Fix the access, keep the
  key. Rotate only on positive evidence the *key itself* is bad — for a
  non-exportable KMS key that means "AWS said the HSM was compromised," ≈never.
- **Not republishing the npm package.** The pinned pubkey is unchanged.
- **Not a consumer action.** Live consumers heal on their next fetch; pinned
  consumers were never exposed.

(The only thing that *would* pull in re-pin + npm vNext + an out-of-band
announcement is an actual key rotation — see above for why that's reserved for
a non-event.)
