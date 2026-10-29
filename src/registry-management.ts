import { registryRequest } from "./registry-api.js";
import { processCancellation } from "../scripts/owned-child.mjs";
import { workQueue } from "../scripts/work-admission.mjs";
import { RegistryProvider, type RegistryManagement } from "./registry-management-contract.js";
export { RegistryProvider, type RegistryManagement } from "./registry-management-contract.js";
import { imageDigest, imageHash, parsePreparedTag } from "./image-contract.js";
import { record, records, string, strings } from "../scripts/values.mjs";

export interface ManagedRegistryImage {
  image: string;
  tags: string[];
  created: string;
  identity: string;
  endpoint: string;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Invalid registry API object identity");
  return Number(value);
}
async function pages(
  management: RegistryManagement,
  endpoint: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let bytes = 0;
  for (let page = 1; page <= 100; page++) {
    const entries = records(
      await registryRequest(management, `${endpoint}?per_page=100&page=${String(page)}`, { signal }),
      "Invalid registry page",
    );
    bytes += Buffer.byteLength(JSON.stringify(entries));
    if (bytes > 16 * 1024 * 1024)
      throw new Error("Registry inventory exceeds its metadata byte budget; narrow the repository before pruning");
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error("Registry inventory exceeds 10000 entries; narrow the repository before pruning");
}
function creationTime(value: unknown): string {
  const created = string(value, "Missing registry creation time");
  if (!created || created.length > 128) throw new Error("Invalid registry creation time");
  return created;
}
function ghcrImage(value: unknown, endpoint: string): ManagedRegistryImage {
  const version = record(value, "Invalid GHCR version");
  const identity = id(version.id);
  const image = string(version.name, "Missing registry image digest");
  const metadata = record(version.metadata, "Invalid GHCR metadata");
  const container = record(metadata.container, "Invalid GHCR container metadata");
  const tags = strings(container.tags, "Invalid registry tags");
  if (!imageDigest.test(image)) throw new Error("Invalid registry image digest");
  return {
    image,
    tags,
    created: creationTime(version.created_at),
    endpoint,
    identity: imageHash(JSON.stringify([identity, image, [...tags].sort()])),
  };
}
function gitlabImage(value: unknown, endpoint: string): ManagedRegistryImage {
  const tag = record(value, "Invalid GitLab registry tag");
  const name = string(tag.name, "Missing registry tag name");
  const image = string(tag.digest, "Missing registry tag digest");
  const created = creationTime(tag.created_at);
  if (!imageDigest.test(image)) throw new Error("Invalid registry image digest");
  return { image, tags: [name], created, endpoint, identity: imageHash(JSON.stringify([name, image, created])) };
}

/** Provider APIs own inventory and deletion; Docker owns authenticated OCI image transport. */
export async function managedRegistryImages(
  repository: string,
  management: RegistryManagement,
  signal?: AbortSignal,
): Promise<ManagedRegistryImage[]> {
  const owner = signal ? undefined : processCancellation();
  const active = signal ?? owner?.signal;
  if (!active) throw new Error("Registry inventory requires an operation owner");
  try {
    switch (management.provider) {
      case RegistryProvider.GHCR: {
        const match = /^ghcr\.io\/([^/]+)\/(.+)$/.exec(repository);
        if (!match?.[1] || !match[2]) throw new Error("GHCR management requires a GHCR repository");
        const account = record(
          await registryRequest(management, `users/${match[1]}`, { signal: active }),
          "Invalid GHCR owner",
        );
        if (!["User", "Organization"].includes(String(account.type))) throw new Error("Unsupported GHCR owner");
        const endpoint = `${account.type === "Organization" ? "orgs" : "users"}/${match[1]}/packages/container/${encodeURIComponent(match[2])}/versions`;
        return (await pages(management, endpoint, active)).map((version) =>
          ghcrImage(version, `${endpoint}/${String(id(version.id))}`),
        );
      }
      case RegistryProvider.GitLab: {
        const project = encodeURIComponent(management.project);
        const repositories = await pages(management, `projects/${project}/registry/repositories`, active);
        const selected = repositories.find((entry) => entry.location === repository);
        if (!selected) throw new Error("Configured GitLab container repository was not found in the project");
        const endpoint = `projects/${project}/registry/repositories/${String(id(selected.id))}/tags`;
        const tags = (await pages(management, endpoint, active))
          .map((tag) => string(tag.name, "Missing GitLab registry tag name"))
          .filter((name) => parsePreparedTag(name));
        const images = new Array<ManagedRegistryImage>(tags.length);
        await workQueue(
          tags.map((name, index) => ({ name, index })),
          { capacity: 4, signal: active },
          async ({ name, index }) => {
            const target = `${endpoint}/${encodeURIComponent(name)}`;
            const image = gitlabImage(await registryRequest(management, target, { signal: active }), target);
            if (image.tags[0] !== name) throw new Error("GitLab registry returned another tag");
            images[index] = image;
          },
        );
        return images;
      }
    }
    throw new Error(`Unsupported registry management provider: ${String(management satisfies never)}`);
  } finally {
    owner?.close();
  }
}
export async function revalidateManagedRegistryImage(
  management: RegistryManagement,
  endpoint: string,
  identity: string,
  signal?: AbortSignal,
): Promise<void> {
  const value = await registryRequest(management, endpoint, { ...(signal ? { signal } : {}) });
  let image: ManagedRegistryImage;
  switch (management.provider) {
    case RegistryProvider.GHCR:
      image = ghcrImage(value, endpoint);
      break;
    case RegistryProvider.GitLab:
      image = gitlabImage(value, endpoint);
      break;
  }
  if (image.identity !== identity) throw new Error("Registry image changed; inspect again");
}
export async function deleteManagedRegistryImage(
  management: RegistryManagement,
  endpoint: string,
  signal?: AbortSignal,
): Promise<void> {
  await registryRequest(management, endpoint, { method: "DELETE", ...(signal ? { signal } : {}) });
}
