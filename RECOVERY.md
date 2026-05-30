# RECOVERY — key compromise runbook

The signing key lives in **AWS KMS** and is non-exportable. There is no
elaborate revocation system, by design (see "Why no revocation" below). This
is the runbook for the one scenario that matters: someone gained the ability
to call `kms:Sign` (an AWS account / IdP compromise — *not* "cracking the
HSM," which isn't a thing).

## Facts you'll need

| | |
|---|---|
| AWS account | `312670213421` |
| Region | `us-west-2` |
| Key | `alias/datamancy-signing` — KeyId `5d291546-7379-4ed9-88a1-cbe45b9e86c2` |
| Spec | ECDSA `ECC_NIST_P256`, `SIGN_VERIFY` |
| Signer (scoped, `kms:Sign` only) | SSO profile `datamancy-signer` |
| Admin (can disable/rotate) | a `PowerUserAccess` SSO session (NOT the scoped signer) |
| Pinned pubkey (the trust root) | `datamancy/src/pinned-pubkey.ts` |
| Signer script | `datamancy.dev/scripts/sign-manifest.mjs` |
| Content host | datamancy.dev (Cloudflare Pages ← GitHub `watmin/datamancy.dev`) |

## Detection

Watch CloudTrail for `kms:Sign` events you didn't make. Set a CloudWatch
alarm on `kms:Sign` against this key — every legitimate sign is rare and
deliberate, so any unexpected one is a signal.

## Step 1 — Kill the signing ability (instant, source-side)

The scoped `datamancy-signer` role canNOT disable the key; only admin can. So
a compromised *signer* session can sign but cannot stop you from pulling the
plug.

**Console (fastest under pressure):** KMS → Customer managed keys →
`datamancy-signing` → Key actions → **Disable**.

**CLI (needs an admin/PowerUserAccess profile, not the scoped signer):**
```bash
aws kms disable-key --key-id alias/datamancy-signing \
  --region us-west-2 --profile <admin-profile>
```
After this, **no one can sign a new manifest** — the attacker included.
Disabling does NOT break consumers: they verify against the *pinned pubkey*,
not KMS, so already-signed manifests still verify. It only freezes new
versions.

## Step 2 — Un-serve any malicious manifest (no signing needed)

Disabling stops *future* signing but does not retract a malicious manifest the
attacker already signed and served. To remove it without signing anything,
**revert the channel to the last known-good bytes** (which are already signed
and sitting in git history):

```bash
cd datamancy.dev
git revert <bad-commit>            # or: git reset --hard <last-good-commit> && force-push
git push                            # Cloudflare redeploys the known-good manifest
```
Pinned consumers were never exposed (they froze a good hash and never follow
latest). This step protects the *live* consumers.

## Step 3 — Remediate the account, then resume with the SAME key

This is the part that matters, and where the KMS model diverges sharply from a
stolen key-file. **The key material was never exposed** — KMS keys are
non-exportable, so the attacker never held the secret, only the temporary
*permission* to call `kms:Sign`. Take that permission away and the key is
trustworthy again. Fix the account, not the key:

- Rotate the compromised AWS credentials / kill the bad SSO sessions.
- Close the hole they came through (IAM misconfig, leaked IdP creds, etc.).
- Audit CloudTrail for everything they did during the window.

Then re-enable the key and resume signing — **no new key, no re-pin, no package
republish, no consumer action:**

```bash
aws kms enable-key --key-id alias/datamancy-signing \
  --region us-west-2 --profile <admin-profile>
# then regenerate + sign the manifest as normal and push
```

The pinned pubkey is unchanged, so every consumer keeps working. Recovery
stays entirely inside your AWS account + the channel.

## When to actually rotate the key (rarely)

Rotation — new key, re-pin `src/pinned-pubkey.ts`, publish a new npm version,
announce so pinned/mirrored consumers re-pin — is warranted **only** if you have
positive reason to distrust the **key material itself**. With a non-exportable
KMS key that essentially means "AWS notified me the HSM was compromised," which
is not a realistic event. Do NOT rotate reflexively after an account
compromise — that treats the wrong layer. Fix the access; keep the key. Rotate
only on evidence the *key*, not the *access*, is bad.

## Why no revocation system

With KMS the key can't be stolen, only *mis-invoked* via an account
compromise — already mitigated by SSO + MFA + least-privilege (`kms:Sign`
only) + CloudTrail, and recoverable by the steps above. `kms:disable-key` is a
built-in source-side kill the scoped signer can't touch; pinning immunizes the
careful; npm v2 heals the rest. A cold-key revocation system (second keypair,
pre-signed cert, out-of-band channel, consumer fetch logic) would buy only
"faster dark during the compromise window before v2 propagates" — a sliver of
residual risk at large complexity. Deliberately not built.
