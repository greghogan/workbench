import { readBoundedFile } from "./file-reads.js";
import { join } from "node:path";

export const distributionSourceFile = "workbench-source.json";

export interface DistributionSource {
  repository: string;
  revision: string;
}

/** A package identity is optional for development trees, but malformed identities never fall back. */
export function readDistributionSource(distribution: string): DistributionSource | undefined {
  const path = join(distribution, distributionSourceFile);
  let contents: string;
  try {
    contents = readBoundedFile(path, 16384, "Workbench source identity").toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid Workbench source identity", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Invalid Workbench source identity");
  }
  return parseDistributionSource(value);
}

export function parseDistributionSource(value: unknown): DistributionSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Workbench source identity");
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(",") !== "repository,revision,schema_version" ||
    source.schema_version !== 1 ||
    typeof source.repository !== "string" ||
    typeof source.revision !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.revision)
  )
    throw new Error("Invalid Workbench source identity");
  return { repository: source.repository, revision: source.revision };
}
