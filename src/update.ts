import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readToml, type Config } from "./core.js";

import { gitEnvironment, git, clean, cloneTree, entries, prepareManagedPatch } from "./update-git.js";
import { readDistributionPin } from "./distribution-manifest.js";
import { updateSharedInstallation } from "./update-shared.js";

/** Fetch and prepare with the new executable before publishing any checkout changes. */
export function updateWorkbench(root: string, requested?: string): void {
  if (resolve(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== resolve(root))
    throw new Error("update must run for the project repository root");
  if (readDistributionPin(root)) {
    updateSharedInstallation(root, requested);
    return;
  }
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
        WORKBENCH_LOCAL_CONFIG_ROOT: root,
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `target Workbench preparation or validation failed (${String(result.error ?? result.status)}); checkout unchanged`,
      );
    clean(nextDependency);
    const { changes, patch, agentDiff, privateContext } = prepareManagedPatch(root, prepared, original, temporary);
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
      if (privateContext)
        console.log(
          "Agent context changed and includes private policy; review the local AGENTS.md diff with a private audience. Context text is omitted from this report.",
        );
      else {
        console.log("Agent context changed; review inherited and scoped instructions:");
        console.log(agentDiff);
      }
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
