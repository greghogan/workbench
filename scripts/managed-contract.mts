import { isRecord, records } from "./values.mjs";
export interface ManagedPreparationPlan {
  builder: "guix" | "nix";
  cores: number;
  maxJobs: number;
  output: string;
  imageRoot: string;
  runtimeOwner: string;
  runtime?: string;
  guix?: { channels: string; runtime: string; imageRoot: string; roots: number[] }[];
  roots: { path: string; profile: string }[];
}
import type { BinaryLike } from "crypto";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A subproject's complete channel declaration replaces the project default. */
export function guixChannelFile(project: string, directory: string = project): string {
  const local = join(directory, "channels.scm");
  return lstatSync(local, { throwIfNoEntry: false }) ? local : join(project, "channels.scm");
}
export function guixChannelGroups(project: string, roots: { path: string }[]): { channels: string; roots: number[] }[] {
  const groups = new Map<string, { channels: string; roots: number[] }>();
  for (const [index, root] of roots.entries()) {
    const channels = guixChannelFile(project, join(project, root.path));
    const identity = createHash("sha256").update(readFileSync(channels)).digest("hex");
    const group = groups.get(identity) ?? { channels, roots: [] };
    group.roots.push(index);
    groups.set(identity, group);
  }
  return [...groups.values()];
}
export const builderOwner = (checkout: BinaryLike) => createHash("sha256").update(checkout).digest("hex");
export function builderDirectory(cacheRoot: string, checkout: string, builder: string): string {
  if (!["native", "guix", "nix"].includes(builder)) throw new Error("Invalid managed builder");
  return join(cacheRoot, "offline-builders", builderOwner(checkout), builder);
}
export function builderVolumes(builder: string, key: string): { name: string; destination: string }[] {
  if (!["guix", "nix"].includes(builder) || !/^[a-f0-9]{24}$/.test(key))
    throw new Error("Invalid builder volume identity");
  return (
    builder === "guix" ? [["store", "/gnu"] as const, ["state", "/var/guix"] as const] : [["store", "/nix"] as const]
  ).map(([role, destination]) => ({ name: `workbench-${builder}-${key}-${role}`, destination }));
}
export function builderCacheKey(owner: string, builder: string, architecture: string, image: string): string {
  return createHash("sha256")
    .update(JSON.stringify([owner, builder, architecture, image]))
    .digest("hex")
    .slice(0, 24);
}
function assertManagedPlan(plan: unknown): asserts plan is ManagedPreparationPlan {
  const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
  const relative = (value: unknown): value is string =>
    typeof value === "string" &&
    (value === "." ||
      (!isAbsolute(value) &&
        !value.includes("\\") &&
        value.split("/").every((part) => part && part !== "." && part !== "..")));
  if (
    !isRecord(plan) ||
    (plan.builder !== "guix" && plan.builder !== "nix") ||
    typeof plan.cores !== "number" ||
    !Number.isSafeInteger(plan.cores) ||
    plan.cores < 1 ||
    typeof plan.maxJobs !== "number" ||
    !Number.isSafeInteger(plan.maxJobs) ||
    plan.maxJobs < 1 ||
    !absolute(plan.output) ||
    !absolute(plan.imageRoot) ||
    !absolute(plan.runtimeOwner) ||
    !Array.isArray(plan.roots) ||
    !plan.roots.length ||
    plan.roots.some((root) => !isRecord(root) || !relative(root.path) || !absolute(root.profile)) ||
    new Set(records(plan.roots, "Invalid managed roots").map((root) => root.path)).size !== plan.roots.length ||
    new Set(records(plan.roots, "Invalid managed roots").map((root) => root.profile)).size !== plan.roots.length ||
    (plan.builder === "guix" ? !absolute(plan.runtime) : plan.runtime !== undefined)
  )
    throw new Error("Invalid managed preparation plan");
  const rootCount = plan.roots.length;
  if (plan.builder === "guix") {
    if (
      !Array.isArray(plan.guix) ||
      !plan.guix.length ||
      plan.runtime !== records(plan.guix, "Invalid Guix groups")[0]?.runtime ||
      plan.guix.some(
        (group) =>
          !isRecord(group) ||
          !absolute(group.channels) ||
          !absolute(group.runtime) ||
          !absolute(group.imageRoot) ||
          !Array.isArray(group.roots) ||
          !group.roots.length ||
          group.roots.some(
            (index: unknown) =>
              typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= rootCount,
          ),
      ) ||
      new Set(records(plan.guix, "Invalid Guix groups").map((group) => group.runtime)).size !== plan.guix.length ||
      new Set(records(plan.guix, "Invalid Guix groups").map((group) => group.imageRoot)).size !== plan.guix.length
    )
      throw new Error("Invalid Guix channel groups");
    const roots = records(plan.guix, "Invalid Guix groups").flatMap((group) => {
      if (!Array.isArray(group.roots)) throw new Error("Invalid Guix roots");
      return group.roots as unknown[];
    });
    if (roots.length !== plan.roots.length || new Set(roots).size !== roots.length)
      throw new Error("Guix channel groups must cover every root exactly once");
  } else if (plan.guix !== undefined) throw new Error("Nix preparation cannot contain Guix channel groups");
}

export function validateManagedPlan(plan: unknown): ManagedPreparationPlan {
  assertManagedPlan(plan);
  return plan;
}
