import { Command, Option } from "commander";
import { resolve } from "node:path";
import { buildEnvironment, buildPaths, cleanBuilds, prepareBuild } from "../core/artifacts/builds.js";
import { executePreparedProfile } from "../core/artifacts/offline-profiles.js";
import { CheckNetwork } from "../core/execution/checks/check-network.mjs";
import { runCIChecks } from "../core/execution/ci/ci-checks.js";
import { ciDestination } from "../core/execution/ci/ci-destinations.js";
import { acquireCIImage } from "../core/execution/ci/ci-images.js";
import { direnvWatchPaths } from "../core/execution/environments/direnv.js";
import { checkEnvironment } from "../core/execution/environments/environments.js";
import { writeAtomic } from "../core/runtime/file-publication.mjs";
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
  registerCommand(program, "ci-image-exec", { hidden: true })
    .argument("<profile>")
    .argument("[command...]")
    .option("--image <id>")
    .option("--reports <path>")
    .option("--env-json <json>")
    .addOption(new Option("--network <mode>").choices(["host", "none"]).default("host"))
    .action(
      async (
        profile: string,
        command: string[],
        options: { image?: string; reports?: string; envJson?: string; network: "host" | "none" },
      ) => {
        if (!command.length) throw new Error("ci-image-exec needs a command");
        const env: unknown = options.envJson ? JSON.parse(options.envJson) : {};
        if (
          !env ||
          typeof env !== "object" ||
          Array.isArray(env) ||
          Object.entries(env).some(
            ([key, value]) =>
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"),
          )
        )
          throw new Error("Invalid container environment");
        await executePreparedProfile(root, profile, command, {
          network: options.network,
          ...(options.image ? { image: options.image } : {}),
          ...(options.reports ? { reports: resolve(options.reports) } : {}),
          env: env as Record<string, string>,
        });
      },
    );
}
