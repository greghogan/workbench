import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitEnvironment } from "../distribution/update-git.js";
import { projectPathComparison } from "../projects/project-registry.js";
import { userDirectory } from "../storage/storage.js";

/** Repository identity groups related checkouts without depending on their branch or history. */
export function taskRepositoryDirectory(root: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    env: { ...gitEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error && (!("code" in result.error) || result.error.code !== "ENOENT")) throw result.error;
  return result.status === 0 ? realpathSync.native(resolve(root, result.stdout.trim())) : undefined;
}

export function taskProjectStateFile(project: string, category: "task-decisions" | "task-implementations"): string {
  return join(
    userDirectory("state"),
    category,
    createHash("sha256").update(projectPathComparison(project)).digest("hex") + ".json",
  );
}
