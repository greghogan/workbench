import { existsSync } from "node:fs";
import { parse } from "smol-toml";
import { repositoryStatePath } from "../../git/repository-state.js";
import { validateBranch } from "../../git/refs.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import { record } from "../../runtime/values.mjs";
import { planningPaths } from "./plan-model.js";

export interface PlanningSettings {
  branch?: string;
  remote?: string;
  remote_branch?: string;
  auto_prune: boolean;
}

/** Settings remain available to Git hooks without loading plan documents or presentation dependencies. */
export function planningSettings(root: string): PlanningSettings {
  const path = repositoryStatePath(root, planningPaths.settings);
  if (!existsSync(path)) return { auto_prune: true };
  const input = record(
    parse(readBoundedFile(path, 64 * 1024, "planning settings").toString()),
    "Invalid planning settings",
  );
  if (Object.keys(input).some((key) => !["branch", "remote", "remote_branch", "auto_prune"].includes(key)))
    throw new InvalidInput("Unknown planning setting");
  for (const key of ["branch", "remote", "remote_branch"] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || !input[key] || /[\0\r\n]/.test(input[key]) || input[key].startsWith("-"))
    )
      throw new InvalidInput(`Invalid planning ${key}`);
  if (input.auto_prune !== undefined && typeof input.auto_prune !== "boolean")
    throw new InvalidInput("Invalid planning auto_prune");
  if (!!input.remote !== !!input.remote_branch)
    throw new InvalidInput("Select both the planning remote and its destination branch");
  if (typeof input.branch === "string") validateBranch(root, input.branch);
  if (typeof input.remote_branch === "string") validateBranch(root, input.remote_branch);
  return { ...input, auto_prune: input.auto_prune !== false };
}
