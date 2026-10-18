import { existsSync } from "node:fs";
import { readConfig } from "./core.js";
import { imageReference } from "./container-references.js";
import { imageQuery as run } from "./image-process.js";
import {
  imageHash as hash,
  imageDigest,
  imageProfileLock,
  parsePreparedTag,
  imageProtection,
  type RegistryImageReport,
  type RegistryImageEntry,
} from "./image-contract.js";
export function registryImageStatus(reference: string): {
  state: "available" | "missing" | "unavailable";
  detail?: string;
} {
  if (!imageReference(reference)) throw new Error("Invalid registry image reference");
  try {
    const manifest = JSON.parse(run("docker", ["manifest", "inspect", reference])) as { schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2) throw new Error("Registry returned an unsupported image manifest");
    return { state: "available" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return /manifest unknown|no such manifest|manifest_unknown/i.test(detail)
      ? { state: "missing" }
      : { state: "unavailable", detail };
  }
}

interface RegistryVersion {
  id: number;
  name: string;
  created_at: string;
  metadata: { container?: { tags?: string[] } };
}
function registryIdentity(version: RegistryVersion): string {
  return hash(JSON.stringify([version.id, version.name, [...(version.metadata.container?.tags ?? [])].sort()]));
}
function packageEndpoint(repository: string): string {
  const match = /^ghcr\.io\/([^/]+)\/(.+)$/.exec(repository);
  if (!match?.[1] || !match[2]) throw new Error(`Registry pruning currently supports GHCR only: ${repository}`);
  const owner = match[1];
  const account = JSON.parse(run("gh", ["api", "--hostname", "github.com", `users/${owner}`])) as { type: string };
  if (!["User", "Organization"].includes(account.type)) throw new Error(`Unsupported GHCR owner: ${owner}`);
  return `${account.type === "Organization" ? "orgs" : "users"}/${owner}/packages/container/${encodeURIComponent(match[2])}/versions`;
}

/** Registry inventory is explicit and uses GitHub CLI authentication, separately from Docker transport. */
export function inspectRegistryImages(root: string): RegistryImageReport {
  const report: RegistryImageReport = { location: "registry", entries: [], issues: [] };
  const repositories = new Set<string>();
  for (const profile of readConfig(root).development?.profiles ?? []) {
    const repository = profile.offline?.registry;
    if (!repository || repositories.has(repository)) continue;
    repositories.add(repository);
    try {
      const endpoint = packageEndpoint(repository);
      const pages = JSON.parse(
        run("gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `${endpoint}?per_page=100`]),
      ) as RegistryVersion[][];
      for (const version of pages.flat()) {
        const tags = version.metadata.container?.tags ?? [];
        if (!tags.some((tag) => parsePreparedTag(tag) !== undefined)) continue;
        if (!Number.isSafeInteger(version.id) || version.id < 1 || !imageDigest.test(version.name))
          throw new Error(`${repository}: invalid package version identity`);
        report.entries.push({
          key: hash(`${endpoint}/${String(version.id)}`),
          checkout: root,
          profile: profile.name,
          reference: `${repository}:${tags.find((tag) => parsePreparedTag(tag) !== undefined) ?? ""}`,
          image: version.name,
          bytes: 0,
          lock: imageProfileLock(root, profile.name),
          identity: registryIdentity(version),
          endpoint: `${endpoint}/${String(version.id)}`,
          tags,
          created: version.created_at,
          ...imageProtection(
            tags.some((tag) => !parsePreparedTag(tag))
              ? "unrelatedTags"
              : existsSync(`${imageProfileLock(root, profile.name)}.lock`)
                ? "locked"
                : undefined,
          ),
        });
      }
    } catch (error) {
      report.issues.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

export function revalidateRegistryImage(entry: RegistryImageEntry): void {
  const version = JSON.parse(run("gh", ["api", "--hostname", "github.com", entry.endpoint])) as RegistryVersion;
  if (registryIdentity(version) !== entry.identity)
    throw new Error(`Registry image ${entry.reference} changed; inspect again`);
}
