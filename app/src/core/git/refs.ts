import { spawnSync } from "node:child_process";
import { InvalidInput } from "../runtime/input-errors.js";
import { dirname, join, resolve } from "node:path";
import { gitBytes } from "./git-snapshot.js";

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

/** Include absent loose refs and their ancestors so creation, replacement, and packing invalidate readers. */
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
  const common = resolve(gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()),
    refs = gitBytes(root, ["for-each-ref", "--format=%(refname)", ...prefixes])
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
