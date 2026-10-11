import { createHash } from "node:crypto";
import { artifactLimits } from "./artifact-streams.js";
import type { ToolAsset } from "./tool-downloads.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ArchiveFilter {
  revision: number;
  include: string[];
  required: string[];
}

export const filterIdentity = (filter: ArchiveFilter): string => digest(JSON.stringify(filter));

/** Record proof identities and trust digests, without copying whole keyrings into each installation. */
export function acquisitionProvenance(asset: ToolAsset) {
  const signature = asset.signature ?? asset.checksums?.signature ?? asset.repository?.signature;
  return {
    url: asset.url,
    sha256: asset.sha256,
    format: asset.format,
    strip: asset.strip,
    bin: asset.bin,
    executable: asset.executable,
    build: asset.build,
    phpExtensions: asset.phpExtensions,
    // Source-build recipe changes invalidate the affected compiled installations.
    buildRevision: asset.build === "php" ? 2 : asset.build ? 1 : undefined,
    filter: asset.filter,
    limits: {
      ...artifactLimits,
      entries: asset.archiveLimits?.entries ?? artifactLimits.entries,
      windowLog: asset.zstdWindowLogMax ?? artifactLimits.windowLog,
    },
    evidence: {
      ...(signature
        ? { signature: { url: signature.url, signers: signature.signers, keysSha256: digest(signature.keys) } }
        : {}),
      ...(asset.checksums ? { checksums: { url: asset.checksums.url, subject: asset.checksums.subject } } : {}),
      ...(asset.attestation ? { attestation: { ...asset.attestation, roots: digest(asset.attestation.roots) } } : {}),
      ...(asset.repository ? { repository: { ...asset.repository, signature: undefined } } : {}),
      ...(asset.authenticationUnavailable ? { unavailable: asset.authenticationUnavailable } : {}),
    },
  };
}
export const acquisitionIdentity = (asset: ToolAsset): string => digest(JSON.stringify(acquisitionProvenance(asset)));
