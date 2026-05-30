/**
 * Pinned public key for verifying datamancy.dev manifest signatures.
 *
 * Trust property: tampering with the manifest on datamancy.dev does not
 * affect this constant. The trust root for verification is whatever shipped
 * with this npm package version. The matching PRIVATE key lives in AWS KMS
 * (account 312670213421, us-west-2, alias/datamancy-signing) and is
 * non-exportable — signing happens inside the HSM, the key never touches a
 * disk, CI secret, or running system, and every signature is recorded in
 * CloudTrail.
 *
 * Algorithm: ECDSA P-256 (ECC_NIST_P256) over SHA-256, DER-encoded
 * signatures. KMS does not offer Ed25519; P-256 is what node:crypto verifies
 * against KMS's output.
 *
 * Generated in KMS: 2026-05-30.
 */

export const PINNED_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3K79FKrZKIvwYUwbCBKmDI86SD55
fqrWN/9q7BnIDvgDg825N5bJDhdvt2hbTThniMPl78173P14tr/8G3sPMg==
-----END PUBLIC KEY-----
`;
