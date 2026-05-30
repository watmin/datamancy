/**
 * Pinned public key for verifying datamancy.dev manifest signatures.
 *
 * Trust property: tampering with the manifest on datamancy.dev does not
 * affect this constant. The trust root for verification is whatever
 * shipped with this npm package version. The matching private key lives
 * offline on the maintainer's workstation and is never in any repo, CI
 * secret, or running system.
 *
 * Algorithm: Ed25519.
 *
 * Generated: 2026-05-30.
 */

export const PINNED_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUOdsKAfuFupyxDtO34QQh9xpgpXGlHSmAqZ2UUgod10=
-----END PUBLIC KEY-----
`;
