import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { withBuildLock, withBuildUse } from "../../artifacts/builds.js";
import { withCacheLock, withCacheLockSync } from "../../storage/cache-lock.js";
import { withCacheSizeChanges } from "../../storage/cache-size.js";
import { CheckCancellation } from "./check-cancellation.js";
import { prepareCheckCommand } from "./check-preparation.js";
import { type CompilerSelection } from "../../toolchains/compilers.js";
import { withConfigurationSnapshot } from "../../configuration/configuration-snapshot.js";
import { inSelectedShell, type CheckEnvironment } from "../environments/environments.js";
import { required } from "../../runtime/invariants.js";
import type { ProcessLock } from "../../storage/process-lock.js";
import { withToolCacheUse, withToolCacheUseAsync } from "../../toolchains/tool-cache-lock.js";
import { selectedToolRequirements } from "../../toolchains/tool-references.js";

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
  execution: { output?: "stderr"; toolProbesOnly?: boolean } = {},
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
        toolProbesOnly: execution.toolProbesOnly ?? false,
      });
      const run = () => {
        withCacheSizeChanges([prepared.builds?.directory, prepared.builds?.dependencies], () => {
          prepared.prepare();
          executePreparedCommand(prepared, execution.output);
        });
      };
      const use = () => {
        if (prepared.profileDependencies && !inSelectedShell(directory, selected))
          withCacheLockSync(prepared.profileDependencies, run, 0);
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
        prepared.profileDependencies && !inSelectedShell(directory, selected)
          ? withCacheLock(prepared.profileDependencies, () => run(owner), 0)
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

function executePreparedCommand(prepared: ReturnType<typeof prepareCheckCommand>, output?: "stderr"): void {
  const { invocation, env, name, directory } = prepared;
  const result = spawnSync(required(invocation[0], "expected invocation[0]"), invocation.slice(1), {
    cwd: directory,
    env,
    stdio: output === "stderr" ? ["inherit", 2, "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed with ${String(result.error ?? result.status)}`);
}
