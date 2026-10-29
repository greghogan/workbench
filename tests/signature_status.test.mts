import { expect, test } from "vitest";
import { decodeSignatureEvidence, verifiedSignatureStatus } from "../src/signature-status.ts";

const primary = "A".repeat(40),
  subkey = "B".repeat(40);
const valid = `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${subkey.slice(-16)} Publisher\n[GNUPG:] VALIDSIG ${subkey} 2026-01-01 1767225600 0 4 0 1 10 00 ${primary}\n`;

test("persisted signer evidence rejects untrusted shapes before acquisition", () => {
  const evidence = { fingerprint: subkey, primaryFingerprint: primary, createdAt: 1767225600, expiresAt: 0 };
  expect(decodeSignatureEvidence(evidence)).toEqual(evidence);
  for (const invalid of [
    null,
    [],
    { ...evidence, fingerprint: subkey.slice(-16) },
    { ...evidence, primaryFingerprint: "publisher" },
    { ...evidence, createdAt: -1 },
    { ...evidence, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...evidence, expiresAt: 0.5 },
    { ...evidence, trusted: true },
  ])
    expect(() => decodeSignatureEvidence(invalid)).toThrow(/Invalid persisted signature evidence/);
});

test("signature evidence binds approved primary and signing subkeys without consulting general trust", () => {
  for (const signer of [primary, subkey])
    expect(verifiedSignatureStatus(valid + "[GNUPG:] TRUST_UNDEFINED 0 pgp\n", [signer])).toEqual([
      { fingerprint: subkey, primaryFingerprint: primary, createdAt: 1767225600, expiresAt: 0 },
    ]);
  expect(() => verifiedSignatureStatus(valid, ["C".repeat(40)])).toThrow(/approved fingerprint/);
  // An unused expired subkey does not invalidate a different, currently valid signing subkey.
  expect(verifiedSignatureStatus("[GNUPG:] KEYEXPIRED 1\n" + valid, [primary])).toHaveLength(1);
});

test.each(["EXPKEYSIG", "EXPSIG", "REVKEYSIG", "BADSIG", "ERRSIG", "NO_PUBKEY", "NODATA", "FAILURE"])(
  "%s is rejected even when cryptographic VALIDSIG evidence is present",
  (status) => {
    expect(() => verifiedSignatureStatus(valid.replace("GOODSIG", status), [primary])).toThrow(/verification failed/);
    expect(() => verifiedSignatureStatus(valid + `[GNUPG:] ${status} ${subkey} Publisher\n`, [primary])).toThrow(
      /verification failed/,
    );
  },
);

test("signature groups cannot lend each other a successful signer status", () => {
  expect(() =>
    verifiedSignatureStatus(valid.replace("[GNUPG:] VALIDSIG", "[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG"), [primary]),
  ).toThrow(/incomplete/);
  expect(() => verifiedSignatureStatus(valid.replace("1767225600 0", "1767225600 1767225601"), [primary])).toThrow(
    /expired/,
  );
  expect(() => verifiedSignatureStatus(valid.replace("1767225600", "not-a-time"), [primary])).toThrow(/incomplete/);
});
