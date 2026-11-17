import { spawnSync } from "node:child_process";
import { reviewAuthorityPath } from "../review/review-authority.js";
import { gitReferenceInputs } from "../git/refs.js";
export { inputStamp } from "../runtime/file-identity.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { reviewGit } from "../review/review-service.js";
import { required } from "../runtime/invariants.js";

/** Observe Git's actual configuration origins, including worktree and conditional includes, without retaining values. */
export function observeGitInputs(root: string, observe: (path: string) => void): string {
  let indexPath = "";
  const names = [
    "HEAD",
    "packed-refs",
    "shallow",
    "index",
    "config",
    "config.worktree",
    "info/exclude",
    "workbench/review.json",
  ];
  const paths = reviewGit(root, ["rev-parse", ...names.flatMap((name) => ["--git-path", name])])
    .trimEnd()
    .split("\n");
  for (const [index, name] of names.entries()) {
    const path = resolve(
      root,
      paths.length === names.length
        ? required(paths[index], "Missing Git input path")
        : reviewGit(root, ["rev-parse", "--git-path", name]).trim(),
    );
    observe(path);
    if (name === "index") indexPath = path;
  }
  for (const path of [
    process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig",
    process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git/config"),
  ])
    observe(path);
  const values = reviewGit(root, ["config", "--show-origin", "--name-only", "--null", "--list"]).split("\0");
  for (let index = 0; index + 1 < values.length; index += 2) {
    const origin = values[index];
    if (origin?.startsWith("file:")) observe(resolve(root, origin.slice(5)));
  }
  // Missing included files and the default global ignore file must also invalidate a capture when created.
  const includes = spawnSync(
    "git",
    ["-C", root, "config", "--path", "--show-origin", "--null", "--get-regexp", "^include.*\\.path$"],
    { encoding: "utf8" },
  );
  if (includes.error || (includes.status !== 0 && includes.status !== 1))
    throw new Error("cannot inspect Git configuration inputs");
  const entries = includes.stdout.split("\0");
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const origin = entries[index],
      value = entries[index + 1]?.split("\n").slice(1).join("\n");
    if (origin?.startsWith("file:") && value)
      observe(
        value.startsWith("~/")
          ? join(homedir(), value.slice(2))
          : isAbsolute(value)
            ? value
            : resolve(dirname(resolve(root, origin.slice(5))), value),
      );
  }
  const excludes = spawnSync("git", ["-C", root, "config", "--path", "--get", "core.excludesFile"], {
    encoding: "utf8",
  });
  if (excludes.error || (excludes.status !== 0 && excludes.status !== 1))
    throw new Error("cannot inspect Git ignore inputs");
  observe(
    excludes.status === 0
      ? resolve(root, excludes.stdout.trim())
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git/ignore"),
  );
  observe(reviewAuthorityPath(root));
  for (const path of gitReferenceInputs(root, ["refs/heads/"])) observe(path);
  return indexPath;
}
