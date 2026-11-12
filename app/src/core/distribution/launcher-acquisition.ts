import { writeDiagnosticText } from "../diagnostics/diagnostics.mjs";
import { captureOwnedChild } from "../runtime/owned-child.mjs";
import { cachedNpmWorkbench } from "../toolchains/npm-cache.js";
import { npmCommand, npmRuntimeEnvironment } from "../toolchains/npm-command.js";
import { sameToolPin, specificationPin, toolSpecification } from "../toolchains/tool-pin.js";
import { launchProcess } from "./launcher-runtime.js";
import { readDistributionSource } from "./distribution-identity.js";
import { executingToolPin } from "./launcher-identity.js";
import { join } from "node:path";

/** Standard npm caching owns acquisition; argument arrays and exact pins avoid shell evaluation and silent upgrades. */
export async function npmWorkbench(
  specification: string,
  args: string[],
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
  distribution?: string,
): Promise<void> {
  const requested = specificationPin(specification);
  if (!requested) throw new Error("Invalid pinned Workbench specification");
  const previous = environment.WORKBENCH_LAUNCH_CHAIN;
  let chain: unknown = [];
  try {
    if (previous !== undefined) chain = previous.length <= 16384 ? JSON.parse(previous) : undefined;
  } catch {
    chain = undefined;
  }
  if (!Array.isArray(chain) || chain.length > 8)
    throw new Error("Invalid Workbench launcher handoff history; retry from a fresh shell");
  const history: unknown[] = chain;
  const pins = history.map((entry) => specificationPin(entry));
  if (pins.some((entry) => !entry))
    throw new Error("Invalid Workbench launcher handoff history; retry from a fresh shell");
  const executing = specificationPin(environment.WORKBENCH_EXECUTING_SPEC);
  if (chain.length === 8 || pins.some((entry) => entry && sameToolPin(entry, requested)))
    throw new Error(
      `Pinned Workbench handoff did not converge: requested ${specification}; executing ${executing ? toolSpecification(executing) : "an unidentified launcher"}. Inspect the project tool pin and npm installation metadata.`,
    );
  const env = {
    ...npmRuntimeEnvironment(environment),
    WORKBENCH_EXECUTING_SPEC: specification,
    WORKBENCH_LAUNCH_CHAIN: JSON.stringify([...history, specification]),
  };
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
  // A packaged identity, checked against npm metadata, identifies reusable code;
  // inherited dispatch context alone does not establish what is installed here.
  if (distribution && readDistributionSource(distribution)) {
    const installed = executingToolPin(distribution);
    if (installed && sameToolPin(installed, requested)) {
      await launchProcess(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
        env,
        ...(cwd === undefined ? {} : { cwd }),
      });
      return;
    }
  }
  const { command, prefix } = npmCommand({ environment });
  const controller = new AbortController();
  let cancelled: number | undefined;
  const interrupt = () => {
      cancelled = 130;
      controller.abort();
    },
    terminate = () => {
      cancelled = 143;
      controller.abort();
    };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let cached: string | undefined;
  try {
    let cache = Object.entries(env).find(([name]) => name.toLowerCase() === "npm_config_cache")?.[1];
    if (!cache) {
      const queried = await captureOwnedChild(
        command,
        [...prefix, "config", "get", "cache", "--json"],
        {
          env,
          cwd: cwd ?? process.cwd(),
          signal: controller.signal,
        },
        65536,
      );
      if (queried.status === 0 && !queried.error) {
        try {
          const value: unknown = JSON.parse(queried.stdout);
          if (typeof value === "string") cache = value;
        } catch {
          /* Older/custom npm implementations may not expose JSON configuration. */
        }
      }
    }
    controller.signal.throwIfAborted();
    cached = cache ? await cachedNpmWorkbench(cache, specification, controller.signal) : undefined;
    controller.signal.throwIfAborted();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  if (cancelled !== undefined) {
    process.exitCode = cancelled;
    return;
  }
  if (cached) {
    await launchProcess(process.execPath, [cached, ...args], { env, ...(cwd === undefined ? {} : { cwd }) });
    return;
  }
  await launchProcess(command, [...prefix, "exec", "--yes", `--package=${specification}`, "--", "workbench", ...args], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (process.exitCode !== undefined && ![0, 130, 143].includes(Number(process.exitCode)))
    writeDiagnosticText(
      `workbench: pinned Workbench ${specification.replace("#", " at revision ")} failed with exit ${String(process.exitCode)}`,
    );
}
