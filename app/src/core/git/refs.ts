import { spawnSync } from "node:child_process";
import { InvalidInput } from "../runtime/input-errors.js";
import { dirname, join, resolve } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { repositoryLocation } from "./repository-reads.js";

// The durable markers whose removal can release deferred operations.
export const gitOperationMarkers = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
];

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

export function gitAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new Error("Cannot inspect Git ancestry", { cause: result.error ?? new Error(result.stderr.trim()) });
  return result.status === 0;
}

export function gitRefFormat(root: string): "files" | "reftable" {
  return gitBytes(root, ["rev-parse", "--show-ref-format"]).toString().trim() === "reftable" ? "reftable" : "files";
}

/** Watch the published ref inputs for the active backend, including the linked checkout's own stack. */
export function gitReferenceInputs(root: string, prefixes: readonly string[]): string[] {
  if (
    prefixes.some(
      (ref) =>
        !ref.startsWith("refs/") ||
        /[\\:\0\r\n]/.test(ref) ||
        ref.split("/").some((part) => part === ".." || part === "."),
    )
  )
    throw new InvalidInput("Invalid observed Git reference");
  const locations = repositoryLocation(root, "reference storage layout", () =>
    gitBytes(root, [
      "rev-parse",
      "--path-format=absolute",
      "--show-ref-format",
      "--git-common-dir",
      "--git-dir",
    ]).toString(),
  )
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
  // Query individually when a Git directory name contains a newline.
  const directory = (index: number, option: string) => {
    const path = locations.length === 3 ? locations[index] : undefined;
    return resolve(
      path ??
        gitBytes(root, ["rev-parse", "--path-format=absolute", option])
          .toString()
          .replace(/\r?\n$/, ""),
    );
  };
  const common = directory(1, "--git-common-dir");
  if (locations[0] === "reftable")
    return [...new Set([common, directory(2, "--git-dir")])].map((path) => join(path, "reftable", "tables.list"));
  const refs = gitBytes(root, ["for-each-ref", "--format=%(refname)", ...prefixes])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean),
    paths = new Set([join(common, "packed-refs")]);
  for (const ref of [...prefixes, ...refs]) {
    if (!ref.startsWith("refs/") || ref.split("/").some((part) => part === ".."))
      throw new InvalidInput("Invalid observed Git reference");
    for (let path = join(common, ref); path !== common; path = dirname(path)) paths.add(path);
  }
  return [...paths];
}
