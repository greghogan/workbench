import { required } from "./invariants.js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readProjects, readToml, type Config } from "./core.js";

function gitEnvironment(): NodeJS.ProcessEnv {
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

function git(root: string, args: string[], input?: string): string {
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

function clean(root: string): void {
  if (
    git(root, ["ls-files", "-v", "-z"])
      .split("\0")
      .some((entry) => /^[a-zS]/.test(entry))
  )
    throw new Error(`${root}: update requires a full checkout without assume-unchanged or skip-worktree entries`);
  if (git(root, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).trim())
    throw new Error(`${root}: update requires a clean, committed checkout, including submodules and untracked files`);
}

function entries(root: string): { mode: string; revision: string; path: string }[] {
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
function cloneTree(source: string, destination: string, revision: string, skipWorkbench = false): void {
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

function managedPaths(root: string): string[] {
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

/** Fetch and prepare with the new executable before publishing any checkout changes. */
export function updateWorkbench(root: string, requested?: string): void {
  if (resolve(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== resolve(root))
    throw new Error("update must run for the project repository root");
  const dependency = join(root, ".workbench");
  const pin = entries(root).find((entry) => entry.path === ".workbench" && entry.mode === "160000");
  if (!pin || !existsSync(join(dependency, ".git")))
    throw new Error("update requires an initialized .workbench Git submodule in a consuming project");
  const config = readToml(join(root, "workbench/config.toml")) as Config;
  const revision = requested ?? config.update?.revision;
  const remote = config.update?.remote ?? "origin";
  if (typeof revision !== "string" || !revision.trim() || /^[\s-]|[:\s]/.test(revision))
    throw new Error(
      "supply a branch, tag, or commit: workbench update REVISION; or set update.revision in workbench/config.toml",
    );
  if (typeof remote !== "string" || !git(dependency, ["remote"]).trim().split("\n").includes(remote))
    throw new Error(`unknown Workbench update remote: ${remote}`);
  const lock = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "workbench-update.lock"]).trim();
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(`${lock}: another update may be running; inspect it before removing a stale lock`, {
      cause: error,
    });
  }
  let temporary: string | undefined;
  const recovery = { retain: false };
  try {
    clean(root);
    clean(dependency);
    const original = git(root, ["rev-parse", "HEAD"]).trim();
    if (git(dependency, ["rev-parse", "HEAD"]).trim() !== pin.revision)
      throw new Error("Workbench checkout must match the committed submodule pin");
    const branch = git(dependency, ["branch", "--show-current"]).trim();
    const owned = managedPaths(root);
    console.log(`Fetching Workbench ${remote} ${revision}...`);
    git(dependency, ["fetch", "--no-tags", "--no-recurse-submodules", "--", remote, revision]);
    const target = git(dependency, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).trim();
    temporary = mkdtempSync(join(tmpdir(), "workbench-update-"));
    writeFileSync(
      join(lock, "recovery"),
      JSON.stringify(
        {
          preparation: temporary,
          projectRevision: original,
          previousWorkbench: pin.revision,
          previousBranch: branch,
          targetWorkbench: target,
        },
        null,
        2,
      ) + "\n",
    );
    const prepared = join(temporary, "project");
    cloneTree(root, prepared, original, true);
    const nextDependency = join(prepared, ".workbench");
    rmSync(nextDependency, { recursive: true, force: true });
    cloneTree(dependency, nextDependency, target);
    const executable = join(nextDependency, "bundle/main.cjs");
    if (!existsSync(executable) || !lstatSync(executable).isFile())
      throw new Error("target revision has no runnable Workbench bundle");
    console.log(`Preparing ${pin.revision} -> ${target} in an isolated checkout...`);
    const result = spawnSync(process.execPath, [executable, "update-prepare"], {
      cwd: prepared,
      stdio: "inherit",
      env: {
        ...gitEnvironment(),
        WORKBENCH_PROJECT_ROOT: prepared,
        WORKBENCH_DISTRIBUTION_ROOT: nextDependency,
        WORKBENCH_UPDATE_PREPARATION: prepared,
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `target Workbench preparation or validation failed (${String(result.error ?? result.status)}); checkout unchanged`,
      );
    clean(nextDependency);
    git(prepared, ["add", "--all", "--", ".", ":!.workbench"]);
    // Include generated files even when a consumer ignores them. Existing ignored files are protected by apply --check.
    git(prepared, ["add", "--all", "--force", "--", ...owned.filter((path) => existsSync(join(prepared, path)))]);
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
    clean(root);
    clean(dependency);
    if (
      git(root, ["rev-parse", "HEAD"]).trim() !== original ||
      git(dependency, ["rev-parse", "HEAD"]).trim() !== pin.revision
    )
      throw new Error("checkout changed during update preparation; retry");
    if (patch) git(root, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
    let applied = false;
    try {
      if (patch) {
        applied = true;
        git(root, ["apply", "--whitespace=nowarn", "-"], patch);
      }
      git(dependency, ["checkout", "--quiet", "--detach", "--no-overwrite-ignore", "--no-recurse-submodules", target]);
    } catch (error) {
      try {
        git(dependency, [
          "checkout",
          "--quiet",
          "--no-overwrite-ignore",
          "--no-recurse-submodules",
          ...(branch ? [branch] : ["--detach", pin.revision]),
        ]);
        if (applied) git(root, ["apply", "--reverse", "--whitespace=nowarn", "-"], patch);
      } catch (rollback) {
        recovery.retain = true;
        throw new Error(
          `update failed (${String(error)}) and rollback needs attention; recovery retained at ${temporary}: ${String(rollback)}`,
          { cause: rollback },
        );
      }
      throw error;
    }
    console.log(`Workbench ${pin.revision} -> ${target}; ${String(changes.length / 2)} project file(s) changed.`);
    for (let index = 0; index < changes.length; index += 2)
      console.log(`  ${String(changes[index])} ${String(changes[index + 1])}`);
    if (agentDiff) {
      console.log("Agent context changed; review inherited and scoped instructions:");
      console.log(agentDiff);
    }
    console.log(
      "Review the dependency and project diff together. ADR and EXP changes require human review before commit. Nothing was staged or committed.",
    );
  } finally {
    if (!recovery.retain) {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
