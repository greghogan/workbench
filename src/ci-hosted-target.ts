import { appendBrowserTimings } from "../scripts/ci-browser-timings.mjs";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ciTargets, type CITarget } from "./ci-targets.js";
import { ciDestination } from "./ci-destinations.js";
import { type ImageBuilder } from "./ci-hosting.js";
import { readConfig } from "./project-configuration.js";
import { acquireCIImage } from "./ci-images.js";
import { executePreparedProfile } from "./offline-profiles.js";
import { distributionRoot } from "./project-context.js";
import { executeCITargets } from "../scripts/ci-execution.mjs";
import { runSucceeded, parseRunReport } from "../scripts/ci-results.mjs";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { CILifecycle } from "../scripts/ci-lifecycle.mjs";
import { CIOperation } from "../scripts/ci-operations.mjs";
import type { AcquiredCIImage } from "../scripts/ci-image-contract.mjs";
import { installContainerTools } from "./native-tools.js";

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

/** One result, partition, and retained-report contract serves explicit targets and grouped operations. */
export async function executeHostedCISelection(
  root: string,
  targets: CITarget[],
  reports: string,
  options: { operation?: CIOperation; profile?: string; image?: AcquiredCIImage } = {},
): Promise<void> {
  const lifecycle = new CILifecycle();
  try {
    const output = resolve(root, reports);
    mkdirSync(output, { recursive: true });
    const directory = mkdtempSync(join(output, "run-"));
    console.log(`CI target reports: ${directory}`);
    if (options.profile) {
      const acquired = options.image;
      if (!acquired) throw new Error("Prepared execution requires a verified image");
      writeAtomic(join(directory, "image.json"), JSON.stringify(acquired) + "\n");
      await installContainerTools(root);
      const partitions =
        options.operation === CIOperation.Checks && targets.every((target) => target.kind !== "compatibility")
          ? ["offline", "online"]
          : ["all"];
      for (const network of partitions) {
        await lifecycle.checkpoint();
        const partition = options.operation === undefined ? directory : join(directory, network);
        mkdirSync(partition, { recursive: true });
        writeAtomic(join(partition, "targets.json"), JSON.stringify(targets));
        try {
          await executePreparedProfile(root, options.profile, ["node", "{workbench}/scripts/ci-linux/run.mjs"], {
            image: acquired.image,
            reports: partition,
            network: network === "offline" ? "none" : "host",
            env: {
              RUNNER_TEMP: "/reports",
              WORKBENCH_CI_TARGETS: "/reports/targets.json",
              ...(options.operation === undefined
                ? {}
                : {
                    WORKBENCH_CI_OPERATION: options.operation,
                    WORKBENCH_CI_CHECK_NETWORK: network,
                    WORKBENCH_CI_INSTALL_PREREQUISITES: "1",
                  }),
            },
          });
        } finally {
          appendBrowserTimings(partition, targets.map((target) => target.id).join(", "));
        }
        const result: unknown = JSON.parse(readFileSync(join(partition, "guest-results.json"), "utf8"));
        if (
          !runSucceeded(
            parseRunReport(
              result,
              targets.map((target) => target.id),
              partition,
            ),
          )
        )
          throw new Error("Prepared CI target failed; inspect retained reports");
      }
    } else {
      if (targets.some((target) => target.environment === "devcontainer")) await installContainerTools(root);
      const result = await executeCITargets({
        targets,
        workspace: root,
        distribution: distributionRoot(root),
        reports: directory,
        resultFile: join(directory, "results.json"),
        lifecycle,
        ...(options.operation ? { operation: options.operation, installPrerequisites: true } : {}),
      });
      if (!runSucceeded(result)) throw new Error("CI target failed; inspect retained reports");
    }
    await lifecycle.checkpoint();
  } finally {
    lifecycle.close();
  }
}
