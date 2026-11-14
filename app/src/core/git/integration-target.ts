import { spawnSync } from "node:child_process";
import { InvalidInput } from "../runtime/input-errors.js";
import { readConfig } from "../projects/project-configuration.js";
import { gitBytes } from "./git-snapshot.js";

export interface IntegrationTarget {
  branch: string;
  remote?: string;
}

export function validateBranch(root: string, branch: string): void {
  const result = spawnSync("git", ["-C", root, "check-ref-format", "refs/heads/" + branch], { encoding: "utf8" });
  if (result.error || result.status !== 0 || branch === "HEAD")
    throw new InvalidInput(`Invalid branch name: ${branch}`);
}

/** Discovery is a proposal; callers persist it before depending on it. */
export function integrationTarget(root: string): IntegrationTarget {
  const configured = readConfig(root).integration;
  const remotes = gitBytes(root, ["remote"]).toString().trim().split("\n").filter(Boolean);
  if (configured?.remote && !remotes.includes(configured.remote))
    throw new InvalidInput(`Integration remote not found: ${configured.remote}`);
  if (!configured?.remote && remotes.length > 1)
    throw new InvalidInput("Choose integration.remote explicitly; this repository has multiple remotes.");
  const remote = configured?.remote ?? remotes[0];
  let branch = configured?.branch;
  if (!branch && remote) {
    const head = spawnSync("git", ["-C", root, "symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], {
      encoding: "utf8",
    });
    if (head.error || (head.status !== 0 && head.status !== 1))
      throw new Error("Cannot inspect the remote default branch", { cause: head.error });
    const prefix = `refs/remotes/${remote}/`;
    if (head.status === 0 && head.stdout.trim().startsWith(prefix)) branch = head.stdout.trim().slice(prefix.length);
  }
  if (!branch) {
    const branches = new Set(
      gitBytes(root, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"]).toString().trim().split("\n"),
    );
    branch = ["main", "master"].find((candidate) => branches.has(candidate));
  }
  if (!branch)
    throw new InvalidInput("Set integration.branch explicitly; no remote default, main, or master branch was found.");
  validateBranch(root, branch);
  return { branch, ...(remote ? { remote } : {}) };
}
