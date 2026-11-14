import { spawnSync } from "node:child_process";
import { InvalidInput } from "../runtime/input-errors.js";

export function validateBranch(root: string, branch: string): void {
  const result = spawnSync("git", ["-C", root, "check-ref-format", "refs/heads/" + branch], { encoding: "utf8" });
  if (result.error || result.status !== 0 || branch === "HEAD")
    throw new InvalidInput(`Invalid branch name: ${branch}`);
}
