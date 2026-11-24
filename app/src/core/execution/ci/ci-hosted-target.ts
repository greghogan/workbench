import { appendBrowserTimings } from "./support/ci-browser-timings.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ciTargets, type CITarget } from "./ci-targets.js";
import { ciDestination } from "./ci-destinations.js";
import { type ImageBuilder } from "./ci-hosting.js";
import { readConfig } from "../../projects/project-configuration.js";
import { acquireCIImage } from "./ci-images.js";
import { withPreparedProfile } from "../../artifacts/offline-profiles.js";
import { distributionRoot } from "../../projects/project-context.js";
import { executeCITargets } from "./support/ci-execution.mjs";
import {
  createRunReport,
  errorMessage,
  parseRunReport,
  reportDirectory,
  runSucceeded,
  type RunReport,
} from "./support/ci-results.mjs";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { CILifecycle } from "./support/ci-lifecycle.mjs";
import { CIOperation } from "./support/ci-operations.mjs";
import type { AcquiredCIImage } from "./support/ci-image-contract.mjs";
import { installContainerTools } from "../../toolchains/native/native-tools.js";
import { combineFailures } from "../../diagnostics/diagnostic-errors.mjs";

/** Every hosting adapter executes the same configured target phases and retains the same result contract. */
export async function runHostedCITarget(root: string, id: string, remote: string, reports: string): Promise<void> {
  const target = ciTargets(root).find((target) => target.id === id);
  if (!target) throw new Error(`Unknown CI target: ${id}`);
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  if (target.os !== os || target.architecture !== process.arch)
    throw new Error("CI targets require their declared native OS and architecture");
  const destination = ciDestination(root, remote);
  const builder = target.environment === "nix-docker" ? "nix" : target.environment;
  const profile = target.os === "linux" ? readConfig(root).ci?.images?.[builder as ImageBuilder] : undefined;
  if (["nix", "guix"].includes(builder) && !profile) throw new Error(`${builder} CI requires ci.images configuration`);
  await executeHostedCISelection(root, [target], reports, {
    ...(profile ? { profile, image: await acquireCIImage(root, profile, destination) } : {}),
  });
}

/** Share dependency acquisition and partition execution across hosted jobs and local rehearsal. */
export async function executePreparedCISelection(
  root: string,
  targets: CITarget[],
  directory: string,
  options: { profile: string; image: string; operation?: CIOperation; candidate?: string },
): Promise<RunReport> {
  const lifecycle = new CILifecycle();
  try {
    const ids = targets.map((target) => target.id);
    const run = createRunReport(ids, directory);
    const split =
      options.operation === CIOperation.Checks && targets.every((target) => target.kind !== "compatibility");
    const networks = split ? ["offline", "online"] : options.operation === CIOperation.Release ? ["offline"] : ["all"];
    const selections = targets.map((target) => ({
      path: target.path,
      ...(target.kind === "native" && target.toolchain ? { toolchain: target.toolchain } : {}),
    }));
    const candidate =
      options.operation === CIOperation.Release ||
      (options.operation === undefined && targets.some((target) => target.release))
        ? options.candidate
        : undefined;
    const partitionRoot = ids.length === 1 && ids[0] !== undefined ? reportDirectory(directory, ids[0]) : directory;
    const env = {
      RUNNER_TEMP: "/reports",
      WORKBENCH_CI_TARGETS: "/reports/targets.json",
      ...(candidate ? { WORKBENCH_CI_CANDIDATE: "/reports/candidate" } : {}),
      ...Object.fromEntries(
        ["WORKBENCH_COVERAGE_BASE", "WORKBENCH_CPU_BUDGET", "WORKBENCH_CPUS"].flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      ...(options.operation === undefined
        ? {}
        : { WORKBENCH_CI_OPERATION: options.operation, WORKBENCH_CI_INSTALL_PREREQUISITES: "1" }),
    };
    await withPreparedProfile(root, options.profile, { image: options.image, selections }, async (execute) => {
      for (const network of networks) {
        await lifecycle.checkpoint();
        const partition = split ? join(partitionRoot, network) : directory;
        mkdirSync(partition, { recursive: true });
        writeAtomic(join(partition, "targets.json"), JSON.stringify(targets));
        if (candidate) cpSync(candidate, join(partition, "candidate"), { recursive: true });
        let failure: unknown;
        try {
          await execute(["node", "{workbench}/scripts/ci-linux/run.mjs"], {
            reports: partition,
            network: network === "offline" ? "none" : "host",
            env: { ...env, WORKBENCH_CI_CHECK_NETWORK: network },
          });
        } catch (error) {
          failure = error;
        } finally {
          appendBrowserTimings(partition, ids.join(", "));
        }
        await lifecycle.checkpoint();
        let result: RunReport;
        try {
          result = parseRunReport(
            JSON.parse(readFileSync(join(partition, "guest-results.json"), "utf8")),
            ids,
            directory,
          );
        } catch (error) {
          if (failure !== undefined) throw combineFailures(failure, error, "Read prepared CI results");
          throw error;
        }
        if (failure !== undefined && runSucceeded(result))
          result.errors.push({ phase: network, message: errorMessage(failure) });
        const started = new Map(run.targets.map((target) => [target.id, target.started]));
        run.targets = result.targets.map((target) => {
          const initial = started.get(target.id);
          return initial === undefined ? target : { ...target, started: initial };
        });
        run.errors.push(...result.errors);
        if (!runSucceeded(run)) break;
      }
    });
    await lifecycle.checkpoint();
    return run;
  } finally {
    lifecycle.close();
  }
}

/** Retain each hosted operation's verified image and reports. */
export async function executeHostedCISelection(
  root: string,
  targets: CITarget[],
  reports: string,
  options: { operation?: CIOperation; profile?: string; image?: AcquiredCIImage; candidate?: string } = {},
): Promise<void> {
  const output = resolve(root, reports);
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "run-"));
  console.log(`CI target reports: ${directory}`);
  if (options.profile) {
    if (!options.image) throw new Error("Prepared execution requires a verified image");
    writeAtomic(join(directory, "image.json"), JSON.stringify(options.image) + "\n");
    await installContainerTools(root);
    const run = await executePreparedCISelection(root, targets, directory, {
      ...options,
      profile: options.profile,
      image: options.image.image,
    });
    if (!runSucceeded(run)) throw new Error("Prepared CI target failed; inspect retained reports");
    return;
  }
  if (targets.some((target) => target.environment === "devcontainer")) await installContainerTools(root);
  const result = await executeCITargets({
    targets,
    workspace: root,
    distribution: distributionRoot(root),
    reports: directory,
    resultFile: join(directory, "results.json"),
    ...(options.operation ? { operation: options.operation, installPrerequisites: true } : {}),
  });
  if (!runSucceeded(result)) throw new Error("CI target failed; inspect retained reports");
}
