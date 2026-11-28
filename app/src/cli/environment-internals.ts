import { Command, Option } from "commander";
import { resolve } from "node:path";
import { buildEnvironment, buildPaths, cleanBuilds, prepareBuild } from "../core/artifacts/builds.js";
import { imageDigest } from "../core/artifacts/image-contract.js";
import { CheckNetwork } from "../core/execution/checks/check-network.mjs";
import { runCIChecks } from "../core/execution/ci/ci-checks.js";
import { ciDestination } from "../core/execution/ci/ci-destinations.js";
import { acquireCIImage, restoreCIImage } from "../core/execution/ci/ci-images.js";
import { executeHostedCISelection, executePreparedCISelection } from "../core/execution/ci/ci-hosted-target.js";
import { readCITargets } from "../core/execution/ci/support/ci-contract.mjs";
import { operationPhases, readCIOperation } from "../core/execution/ci/support/ci-operations.mjs";
import { runSucceeded, writeRunReport } from "../core/execution/ci/support/ci-results.mjs";
import { direnvWatchPaths } from "../core/execution/environments/direnv.js";
import { checkEnvironment } from "../core/execution/environments/environments.js";
import { writeAtomic } from "../core/runtime/file-publication.mjs";
import { readBoundedFile } from "../core/runtime/file-reads.js";
import { autoPrune } from "../core/storage/auto-prune.js";
import { dependencySetup, pnpmStorageConfiguration } from "../core/toolchains/dependencies.js";
import { quote } from "../core/toolchains/toolchains.js";
import { registerCommand } from "./commands.js";

export function registerEnvironmentInternals(program: Command, root: string): void {
  registerCommand(program, "paths")
    .description("Show build, prepared artifact, and dependency locations, or emit shell/direnv integration")
    .option("--path <path>", "Language root relative to the repository (default: current directory)")
    .option("--environment <environment>", "Select the execution environment")
    .option("--toolchain <name>", "Select a named native compiler/runtime profile")
    .option("--shell", "Prepare build storage and print shell exports")
    .option("--direnv", "Print shell exports and direnv watches for selected settings and tool inputs")
    .action(
      (options: { path?: string; environment?: string; toolchain?: string; shell?: boolean; direnv?: boolean }) => {
        if (options.shell && options.direnv) throw new Error("select --shell or --direnv, not both");
        const paths = buildPaths(
          root,
          options.path === undefined ? process.cwd() : resolve(root, options.path),
          options.environment === undefined ? undefined : checkEnvironment(options.environment, "--environment"),
          options.toolchain === undefined ? {} : { toolchain: options.toolchain },
        );
        if (options.shell || options.direnv) {
          prepareBuild(paths);
          for (const [key, value] of Object.entries(buildEnvironment(paths)))
            console.log(`export ${key}=${quote(value)}`);
          if (options.direnv) console.log(`watch_file ${direnvWatchPaths(root, paths).map(quote).join(" ")}`);
        } else console.log(JSON.stringify({ ...paths, variables: buildEnvironment(paths) }, null, 2));
      },
    );
  registerCommand(program, "build-clean", { hidden: true })
    .argument("<repository>")
    .option("--dependencies")
    .action((repository: string, options: { dependencies?: boolean }) => {
      cleanBuilds(buildPaths(resolve(repository), process.cwd(), "native", {}, false), options.dependencies);
    });
  registerCommand(program, "pnpm-config", { hidden: true })
    .argument("<directory>")
    .action((directory: string) => {
      console.log(JSON.stringify(pnpmStorageConfiguration(root, resolve(directory))));
    });
  registerCommand(program, "dependency-setup", { hidden: true })
    .argument("<command...>")
    .action((command: string[]) => {
      dependencySetup(command);
    });
  registerCommand(program, "cache-auto-prune", { hidden: true })
    .argument("[root]")
    .action(async (requested: string | undefined) => {
      await autoPrune(requested ? resolve(requested) : root);
    });
  registerCommand(program, "ci-image-acquire", { hidden: true })
    .argument("<profile>")
    .requiredOption("--output <path>")
    .option("--destination <remote>")
    .action(async (profile: string, options: { output: string; destination?: string }) => {
      const result = await acquireCIImage(
        root,
        profile,
        options.destination ? ciDestination(root, options.destination) : undefined,
      );
      writeAtomic(resolve(options.output), JSON.stringify(result) + "\n");
    });
  registerCommand(program, "ci-checks", { hidden: true })
    .argument("<path>")
    .option("--environment <environment>", "", "native")
    .option("--toolchain <name>")
    .addOption(new Option("--network <selection>").choices(Object.values(CheckNetwork)).default(CheckNetwork.All))
    .action((path: string, options: { environment: string; toolchain?: string; network: CheckNetwork }) =>
      runCIChecks(root, path, options.environment, options.network, options.toolchain),
    );
  registerCommand(program, "ci-image-job", { hidden: true })
    .argument("<profile>")
    .requiredOption("--targets <path>")
    .requiredOption("--reports <path>")
    .option("--prepared <path>")
    .option("--local-image <id>")
    .option("--operation <operation>")
    .option("--candidate <path>")
    .action(
      async (
        profile: string,
        options: {
          targets: string;
          reports: string;
          prepared?: string;
          localImage?: string;
          operation?: string;
          candidate?: string;
        },
      ) => {
        const json = (path: string, bytes: number): unknown =>
          JSON.parse(readBoundedFile(resolve(path), bytes, "CI operation input").toString("utf8")) as unknown;
        const targets = readCITargets(json(options.targets, 16 * 1024 * 1024));
        const operation = options.operation === undefined ? undefined : readCIOperation(options.operation);
        if (
          process.platform !== "linux" ||
          !targets.length ||
          new Set(targets.map((target) => target.id)).size !== targets.length ||
          targets.some(
            (target) =>
              target.os !== "linux" ||
              target.architecture !== process.arch ||
              (operation !== undefined && !operationPhases(target, operation).length),
          )
        )
          throw new Error("Select unique, applicable CI targets for this native Linux operation");
        if (options.localImage !== undefined) {
          if (
            options.prepared !== undefined ||
            options.candidate !== undefined ||
            !imageDigest.test(options.localImage)
          )
            throw new Error("Select a local image by its immutable ID independently of a hosted CI handoff");
          const reports = resolve(options.reports);
          const run = await executePreparedCISelection(root, targets, reports, {
            profile,
            image: options.localImage,
            ...(operation === undefined ? {} : { operation }),
          });
          writeRunReport(resolve(reports, "job-results.json"), run);
          if (!runSucceeded(run)) process.exitCode = 1;
          return;
        }
        const image = options.prepared
          ? await restoreCIImage(root, profile, json(options.prepared, 64 * 1024))
          : await acquireCIImage(root, profile);
        await executeHostedCISelection(root, targets, options.reports, {
          image,
          profile,
          ...(operation === undefined ? {} : { operation }),
          ...(options.candidate === undefined ? {} : { candidate: resolve(options.candidate) }),
        });
      },
    );
}
