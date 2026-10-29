import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { withBuildLock, withBuildUse } from "./builds.js";
import { withCacheLock, withCacheLockSync } from "./cache-lock.js";
import { withCacheSizeChanges } from "./cache-size.js";
import { CheckCancellation } from "./check-cancellation.js";
import { prepareCheckCommand } from "./check-preparation.js";
import { type CompilerSelection } from "./compilers.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import { inSelectedShell, type CheckEnvironment } from "./environments.js";
import { required } from "./invariants.js";
import type { ProcessLock } from "./process-lock.js";
import { withToolCacheUse, withToolCacheUseAsync } from "./tool-cache-lock.js";
import { selectedToolRequirements } from "./tool-references.js";

export function runCommand(
  directory: string,
  name: string,
  command: string[],
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  dockerImage?: string,
  inspectTools = true,
  lockBuild = false,
  compilerSelection: CompilerSelection & { verbose?: boolean } = {},
): void {
  withConfigurationSnapshot(() => {
    const execute = () => {
      const prepared = prepareCheckCommand({
        directory: directory,
        name: name,
        command: command,
        selected: selected,
        repositoryRoot: repositoryRoot,
        dockerImage: dockerImage,
        inspectTools: inspectTools,
        lockBuild: lockBuild,
        compilerSelection: compilerSelection,
      });
      const run = () => {
        withCacheSizeChanges([prepared.builds?.directory, prepared.builds?.dependencies], () => {
          prepared.prepare();
          executePreparedCommand(prepared);
        });
      };
      const use = () => {
        if (prepared.builds && prepared.profile && !inSelectedShell(directory, selected))
          withCacheLockSync(prepared.builds.dependencies, run, 0);
        else run();
      };
      if (prepared.builds && lockBuild) withBuildLock(prepared.builds, use);
      else use();
    };
    if (selected === "native" && inspectTools) {
      const tools = repositoryRoot
        ? selectedToolRequirements(
            repositoryRoot,
            relative(repositoryRoot, directory).replaceAll("\\", "/") || ".",
            compilerSelection,
          )
        : undefined;
      withToolCacheUse(execute, tools);
    } else execute();
  });
}

/** Development commands keep the event loop responsive while active work owns its cache locks. */
export async function runCommandAsync(
  cancellation: CheckCancellation,
  directory: string,
  name: string,
  command: string[],
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  compilerSelection: CompilerSelection = {},
  forwardExitStatus?: (status: number) => void,
): Promise<void> {
  return withConfigurationSnapshot(async () => {
    const execute = async () => {
      cancellation.checkpoint();
      const prepared = prepareCheckCommand({
        directory: directory,
        name: name,
        command: command,
        selected: selected,
        repositoryRoot: repositoryRoot,
        dockerImage: undefined,
        inspectTools: true,
        lockBuild: false,
        compilerSelection: compilerSelection,
      });
      const run = (owner?: ProcessLock) =>
        withCacheSizeChanges([prepared.builds?.directory, prepared.builds?.dependencies], async () => {
          cancellation.checkpoint();
          prepared.prepare();
          await cancellation.execute(prepared.invocation, directory, prepared.env, true, owner, forwardExitStatus);
          cancellation.checkpoint();
        });
      const use = (owner?: ProcessLock) =>
        prepared.builds && prepared.profile && !inSelectedShell(directory, selected)
          ? withCacheLock(prepared.builds.dependencies, () => run(owner), 0)
          : run(owner);
      if (prepared.builds) await withBuildUse(prepared.builds, use);
      else await use();
    };
    if (selected === "native") {
      const tools = repositoryRoot
        ? selectedToolRequirements(
            repositoryRoot,
            relative(repositoryRoot, directory).replaceAll("\\", "/") || ".",
            compilerSelection,
          )
        : undefined;
      await withToolCacheUseAsync(execute, tools);
    } else await execute();
  });
}

function executePreparedCommand(prepared: ReturnType<typeof prepareCheckCommand>): void {
  const { invocation, env, name, directory } = prepared;
  const result = spawnSync(required(invocation[0], "expected invocation[0]"), invocation.slice(1), {
    cwd: directory,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed with ${String(result.error ?? result.status)}`);
}
