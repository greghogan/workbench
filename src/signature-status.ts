import { isRecord } from "../scripts/values.mjs";
import { AcquisitionRejected } from "../scripts/network-retry.mts";

export interface SignatureEvidence {
  fingerprint: string;
  primaryFingerprint: string;
  createdAt: number;
  expiresAt: number;
}

/** Persisted signer evidence uses the same fingerprint and timestamp contract as live GnuPG status. */
export function decodeSignatureEvidence(value: unknown): SignatureEvidence {
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== "string" ||
    typeof value.primaryFingerprint !== "string" ||
    !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(value.fingerprint) ||
    !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(value.primaryFingerprint) ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.createdAt < 0 ||
    value.expiresAt < 0 ||
    Object.keys(value).some((key) => !["fingerprint", "primaryFingerprint", "createdAt", "expiresAt"].includes(key))
  )
    throw new AcquisitionRejected("Invalid persisted signature evidence");
  return {
    fingerprint: value.fingerprint,
    primaryFingerprint: value.primaryFingerprint,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

/** VALIDSIG proves the bytes, while the companion status establishes current signer validity. */
export function verifiedSignatureStatus(status: string, signers: readonly string[]): SignatureEvidence[] {
  const groups: string[][] = [[]];
  for (const line of status.replaceAll("\r", "").split("\n")) {
    if (!line.startsWith("[GNUPG:] ")) continue;
    const record = line.slice(9);
    if (record === "NEWSIG" || record.startsWith("NEWSIG ")) groups.push([]);
    else groups.at(-1)?.push(record);
  }
  const evidence: SignatureEvidence[] = [];
  for (const group of groups) {
    const rejected = group.find((line) =>
      /^(?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY|NODATA|FAILURE)\b/.test(line),
    );
    if (rejected) {
      const code = rejected.split(" ")[0] ?? "FAILURE";
      const reasons: Record<string, string> = {
        EXPKEYSIG: "signing certificate expired",
        EXPSIG: "signature expired",
        REVKEYSIG: "signing certificate revoked",
        BADSIG: "signature does not match the artifact",
        ERRSIG: "signature could not be verified",
        NO_PUBKEY: "signing key is unavailable",
        NODATA: "signature evidence is missing or malformed",
        FAILURE: "verifier reported failure",
      };
      throw new AcquisitionRejected(
        `upstream artifact signature verification failed: ${reasons[code] ?? "invalid status"} (${code})`,
      );
    }
    const valid = group.filter((line) => line.startsWith("VALIDSIG "));
    for (const line of valid) {
      const fields = line.split(" ");
      const fingerprint = fields[1] ?? "";
      const primaryFingerprint = fields[10] ?? fingerprint;
      if (
        !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(fingerprint) ||
        !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(primaryFingerprint) ||
        !/^\d+$/.test(fields[3] ?? "") ||
        !/^\d+$/.test(fields[4] ?? "") ||
        !group.some((record) => record.startsWith("GOODSIG "))
      )
        throw new AcquisitionRejected("upstream artifact signature verification failed: incomplete verifier status");
      if (!signers.includes(fingerprint) && !signers.includes(primaryFingerprint)) continue;
      const createdAt = Number(fields[3]);
      const expiresAt = Number(fields[4]);
      if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt))
        throw new AcquisitionRejected("upstream artifact signature verification failed: invalid signature timestamps");
      if (expiresAt !== 0 && expiresAt <= Date.now() / 1000)
        throw new AcquisitionRejected("upstream artifact signature verification failed: signature expired");
      evidence.push(decodeSignatureEvidence({ fingerprint, primaryFingerprint, createdAt, expiresAt }));
    }
  }
  if (!evidence.length) throw new AcquisitionRejected("artifact signature signer is not an approved fingerprint");
  return evidence;
}
