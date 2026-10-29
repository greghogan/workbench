import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { records, string } from "../values.mjs";
import { type MaintenanceLocator, type MaintenanceTarget } from "./contract.mjs";

export function fileDigest(root: string, path: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");
}
export function developmentRoots(root: string): string[] {
  const data = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  return [
    ...new Set([
      ".",
      ...records(data.language_root, "Missing language roots").map((entry) =>
        string(entry.path, "Missing language root path"),
      ),
    ]),
  ];
}
export type NewMaintenanceTarget<T = MaintenanceTarget> = T extends MaintenanceTarget ? Omit<T, "id"> : never;
export function targetCollector(targets: MaintenanceTarget[]) {
  const ids = new Set<string>();
  return (target: NewMaintenanceTarget) => {
    const { provider, path, name, current, locator, platform } = target;
    const id = JSON.stringify([provider, path, name, locator ?? null, current, platform ?? ""]);
    if (ids.has(id)) return;
    ids.add(id);
    targets.push({ ...target, id });
  };
}

export const locations = {
  field: (...path: string[]): Extract<MaintenanceLocator, { kind: "field" }> => ({ kind: "field", path }),
  group: (name: string): Extract<MaintenanceLocator, { kind: "group" }> => ({ kind: "group", name }),
  property: (name: string): Extract<MaintenanceLocator, { kind: "property" }> => ({ kind: "property", name }),
  marker: (name: string): Extract<MaintenanceLocator, { kind: "marker" }> => ({ kind: "marker", name }),
  action: (revision: string): Extract<MaintenanceLocator, { kind: "action" }> => ({ kind: "action", revision }),
  image: (reference: string): Extract<MaintenanceLocator, { kind: "image" }> => ({ kind: "image", reference }),
  nix: (repository: string, reference: string, fixed = false): Extract<MaintenanceLocator, { kind: "nix" }> => ({
    kind: "nix",
    repository,
    reference: { kind: fixed ? "revision" : "branch", value: reference },
  }),
};
export function locatorField(target: MaintenanceTarget): string[] {
  if (target.locator?.kind !== "field") throw new Error(`Missing field location: ${target.id}`);
  return target.locator.path;
}
export function locatorName(target: MaintenanceTarget): string {
  if (target.locator?.kind !== "group" && target.locator?.kind !== "property" && target.locator?.kind !== "marker")
    throw new Error(`Missing named location: ${target.id}`);
  return target.locator.name;
}
