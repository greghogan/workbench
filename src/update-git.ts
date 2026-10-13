import { readDistributionPin } from "./distribution-manifest.js";
import { required } from "./invariants.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readProjects, readText } from "./core.js";

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    Reflect.deleteProperty(env, key);
  return env;
}

export function git(root: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${String(args[0])}: ${result.stderr.trim() || String(result.error ?? result.status)}`);
  return result.stdout;
}

export function clean(root: string): void {
  if (
    git(root, ["ls-files", "-v", "-z"])
      .split("\0")
      .some((entry) => /^[a-zS]/.test(entry))
  )
    throw new Error(`${root}: update requires a full checkout without assume-unchanged or skip-worktree entries`);
  if (git(root, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).trim())
    throw new Error(`${root}: update requires a clean, committed checkout, including submodules and untracked files`);
}

export function entries(root: string): { mode: string; revision: string; path: string }[] {
  return git(root, ["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error(`${root}: unresolved Git index entry`);
      return {
        mode: required(match[1], "expected match[1]"),
        revision: required(match[2], "expected match[2]"),
        path: required(match[3], "expected match[3]"),
      };
    });
}

/** Clone committed files only; initialized dependencies must match their committed pins. */
export function cloneTree(source: string, destination: string, revision: string, skipWorkbench = false): void {
  mkdirSync(dirname(destination), { recursive: true });
  git(source, ["clone", "--quiet", "--shared", "--no-checkout", "--", source, destination]);
  git(destination, ["checkout", "--quiet", "--detach", revision]);
  for (const entry of entries(destination)) {
    const path = join(destination, entry.path);
    if (entry.mode === "120000") {
      const target = readlinkSync(path);
      const resolved = relative(destination, resolve(dirname(path), target));
      if (isAbsolute(target) || resolved === ".." || resolved.startsWith(`..${sep}`))
        throw new Error(`${entry.path}: update preparation requires symlinks to stay inside their checkout`);
    }
    if (entry.mode !== "160000" || (skipWorkbench && entry.path === ".workbench")) continue;
    const checkout = join(source, entry.path);
    if (!existsSync(join(checkout, ".git")) || git(checkout, ["rev-parse", "HEAD"]).trim() !== entry.revision)
      throw new Error(`${checkout}: initialize the exact committed submodule before updating`);
    clean(checkout);
    rmSync(path, { recursive: true, force: true }); // Empty gitlink directory in the temporary clone.
    cloneTree(checkout, path, entry.revision);
  }
}

export function managedPaths(root: string): string[] {
  const projects = readProjects(root);
  return [
    ...new Set([
      "AGENTS.md",
      ".agents/skills",
      ".claude/skills",
      ...projects.map((project) => join(project.path, "workbench").split(sep).join("/")),
    ]),
  ];
}

export function prepareManagedPatch(root: string, prepared: string, original: string, temporary: string) {
  const owned = managedPaths(root);
  git(prepared, ["add", "--all", "--", ".", ...(readDistributionPin(root) ? [] : [":!.workbench"])]);
  // Include generated files even when a consumer ignores them. Existing ignored files are protected by apply --check.
  git(prepared, [
    "add",
    "--all",
    "--force",
    "--",
    ...owned.filter((path) => existsSync(join(prepared, path))),
    ":(exclude)workbench/.collections/**",
    ":(exclude)workbench/.local-collections/**",
  ]);
  const changes = git(prepared, ["diff", "--cached", "--name-status", "--no-renames", "-z", original])
    .split("\0")
    .filter(Boolean);
  for (let index = 0; index < changes.length; index += 2) {
    const status = required(changes[index], "expected changes[index]");
    const path = required(changes[index + 1], "expected changes[index + 1]");
    if (path.endsWith("/CHARTER.md") || !owned.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      throw new Error(`target migration changed a file outside managed records and context: ${path}`);
    if (
      status === "D" &&
      /(?:^|\/)workbench\/(decisions|tasks|experiments|environments|citations|releases)\//.test(path)
    )
      throw new Error(`migration cannot remove retained record ${path}`);
  }
  const patch = git(prepared, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    original,
  ]);
  writeFileSync(join(temporary, "changes.patch"), patch);
  const agentDiff = changes.includes("AGENTS.md")
    ? git(prepared, ["diff", "--cached", "--no-ext-diff", "--", "AGENTS.md"]).trim()
    : undefined;
  const privateContext = [root, prepared].some((directory) =>
    readText(join(directory, "AGENTS.md")).includes("(private)"),
  );
  return { changes, patch, agentDiff, privateContext };
}
