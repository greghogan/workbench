import { distributionBytes, digest } from "./distribution-manifest.js";

export const distributionManifestFile = "workbench-source-manifest.json";

/** The archive digest binds these original manifest bytes to the candidate's prebuilt executable. */
export function readDistributionManifest(directory: string): { contents: string; sha256: string } {
  const bytes = distributionBytes(directory, distributionManifestFile, 1024 * 1024),
    contents = bytes.toString("utf8");
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Workbench source manifest");
  return { contents, sha256: digest(bytes) };
}
