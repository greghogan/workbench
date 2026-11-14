import { spawnSync } from "node:child_process";
import { InvalidInput } from "../runtime/input-errors.js";

export function validateBranch(root: string, branch: string): void {
  const result = spawnSync("git", ["-C", root, "check-ref-format", "refs/heads/" + branch], { encoding: "utf8" });
  if (result.error || result.status !== 0 || branch === "HEAD")
    throw new InvalidInput(`Invalid branch name: ${branch}`);
}

/** Inspect local objects without starting a partial-clone network acquisition. */
export function gitRevision(root: string, expression: string): string | undefined {
  if (!expression || /[\0\r\n]/.test(expression) || expression.startsWith("-"))
    throw new InvalidInput("Invalid Git revision request");
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", expression], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new Error(`Cannot inspect Git revision ${expression}`, {
      cause: result.error ?? new Error(result.stderr.trim()),
    });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
