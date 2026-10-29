import { record, string } from "../scripts/values.mjs";
import { imageRepository } from "./container-references.js";

export enum RegistryProvider {
  GHCR = "ghcr",
  GitLab = "gitlab",
}
export type RegistryManagement =
  | { provider: RegistryProvider.GHCR; host: string }
  | { provider: RegistryProvider.GitLab; host: string; project: string };
export type RegistryCapability = RegistryManagement | { provider: "none" };

export function readRegistryManagement(value: unknown): Record<string, RegistryCapability> {
  const bindings: Record<string, RegistryCapability> = {};
  for (const [repository, input] of Object.entries(record(value, "Invalid registry management bindings"))) {
    if (!imageRepository(repository)) throw new Error("Registry management bindings require untagged OCI repositories");
    const entry = record(input, "Invalid registry management capability");
    if (Object.keys(entry).some((key) => !["provider", "host", "project"].includes(key)))
      throw new Error("Unknown registry management field");
    if (entry.provider === "none") {
      if (Object.keys(entry).length !== 1) throw new Error("Transport-only registries have no API binding");
      bindings[repository] = { provider: "none" };
      continue;
    }
    const host = string(entry.host, "Registry management requires an API hostname");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(host))
      throw new Error("Invalid registry API hostname");
    try {
      new URL(`https://${host}`);
    } catch {
      throw new Error("Invalid registry API hostname");
    }
    if (entry.provider === RegistryProvider.GHCR) {
      if (!repository.startsWith("ghcr.io/")) throw new Error("GHCR management requires a GHCR repository");
      if (entry.project !== undefined) throw new Error("GHCR management has no project field");
      bindings[repository] = { provider: RegistryProvider.GHCR, host };
      continue;
    }
    if (entry.provider !== RegistryProvider.GitLab)
      throw new Error("Registry management provider must be ghcr, gitlab, or none");
    const project = string(entry.project, "GitLab registry management requires a project");
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project) ||
      project.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Invalid GitLab API project");
    bindings[repository] = { provider: RegistryProvider.GitLab, host, project };
  }
  return bindings;
}
