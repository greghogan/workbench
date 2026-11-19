import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { buildProjectImage } from "../core/artifacts/buildkit.js";
import { buildPaths, prepareBuild } from "../core/artifacts/builds.js";
import { executeDevcontainer } from "../core/artifacts/devcontainers.js";
import { finalizeImage } from "../core/artifacts/image-finalization.js";
import { imageRoots, prepareHostManagedImage } from "../core/artifacts/managed-image.js";
import { prepareNativeImageInputs } from "../core/artifacts/native-image-inputs.js";
import { packageManagerCommand, packageManagerInstallationPlan } from "../core/artifacts/package-manager.js";
import { runCommand } from "../core/execution/checks/check-command.js";
import { nativeCheckEnvironment } from "../core/execution/checks/check-environment.js";
import { executeManagedCommand } from "../core/execution/environments/managed-input-environment.js";
import { distributionRoot } from "../core/projects/project-context.js";
import { required } from "../core/runtime/invariants.js";
import { withCacheSizeChanges } from "../core/storage/cache-size.js";
import { prepareManagedBuilderStore } from "../core/storage/managed-builder-store.js";
import { recordManagedPreparation } from "../core/storage/managed-preparation.js";
import { compilerFamilies, type CompilerFamily } from "../core/toolchains/compiler-catalog.mjs";
import { runMiri } from "../core/toolchains/miri.js";
import {
  nativeAssetPruningPlan,
  pruneNativeAssets,
  publishNativeAssets,
} from "../core/toolchains/native/native-asset-maintenance.js";
import {
  installContainerTools,
  installNativeTools,
  type NativeToolSelection,
} from "../core/toolchains/native/native-tools.js";
import { executePhpCoverage } from "../core/toolchains/php-coverage.js";
import { composerBootstrap, executeComposer } from "../core/toolchains/php-manager.js";
import { executeBundler } from "../core/toolchains/ruby-manager.js";
import { withToolCacheUse } from "../core/toolchains/tool-cache-lock.js";
import { execute } from "../core/toolchains/tool-execution.js";
import { recordResultTools, selectedToolRequirements } from "../core/toolchains/tool-references.js";
import { guardToolchains } from "../core/toolchains/toolchains.js";
import { prepareVcpkg } from "../core/toolchains/vcpkg.js";
import { collect, registerCommand } from "./commands.js";

export function registerToolInternals(program: Command, root: string): void {
  registerCommand(program, "tools-install", { hidden: true })
    .argument("[path]")
    .option("--devcontainer")
    .option("--compiler <family>")
    .option("--compiler-version <version>")
    .option("--toolchain <name>")
    .option("--tool <name>")
    .option("--exclude-tool <name>", "", collect, [])
    .action((path: string | undefined, options: NativeToolSelection & { devcontainer?: boolean; tool?: string }) =>
      options.devcontainer ? installContainerTools(root) : installNativeTools(root, path, options, options.tool),
    );
  registerCommand(program, "image-roots", { hidden: true })
    .option("--path <path>", "Select registered language roots", collect, [])
    .action((options: { path: string[] }) => {
      console.log(
        JSON.stringify(
          imageRoots(
            root,
            options.path.length
              ? options.path
              : process.env.WORKBENCH_IMAGE_ROOTS
                ? (JSON.parse(process.env.WORKBENCH_IMAGE_ROOTS) as unknown)
                : undefined,
          ),
        ),
      );
    });
  registerCommand(program, "managed-builder-store", { hidden: true })
    .argument("<builder>")
    .argument("<bootstrap-image>")
    .action(async (builder: string, image: string) => {
      const store = await prepareManagedBuilderStore(builder, image);
      const profile = process.env.WORKBENCH_PREPARATION_PROFILE;
      if (profile)
        recordManagedPreparation({
          checkout: process.env.WORKBENCH_CONTAINER_CHECKOUT,
          profile,
          architecture: process.env.WORKBENCH_IMAGE_ARCHITECTURE ?? process.arch,
          inputs: process.env.WORKBENCH_IMAGE_INPUTS,
          builder,
          key: store.key,
        });
      console.log(JSON.stringify(store));
    });
  registerCommand(program, "image-finalize", { hidden: true })
    .argument("<source>")
    .argument("<target>")
    .option("--materialize <files...>", "Materialize declared container account files")
    .action((source: string, target: string, options: { materialize?: string[] }) =>
      finalizeImage(source, target, {}, options.materialize ?? []),
    );
  registerCommand(program, "buildkit-build", { hidden: true })
    .allowUnknownOption()
    .argument("<arguments...>")
    .action((args: string[]) => buildProjectImage(root, args));
  registerCommand(program, "managed-image-prepare", { hidden: true })
    .argument("<builder>")
    .argument("<image>")
    .argument("<roots-file>")
    .argument("<output>")
    .action((builder: string, image: string, rootsFile: string, output: string) =>
      prepareHostManagedImage(root, builder, image, rootsFile, output),
    );
  registerCommand(program, "managed-inputs-exec", { hidden: true })
    .argument("<command...>")
    .action((command: string[]) => executeManagedCommand(process.cwd(), command));
  registerCommand(program, "package-manager-exec", { hidden: true })
    .option("--plan", "Print the verified bootstrap selection without installing it")
    .argument("[command...]")
    .action(async (command: string[], options: { plan?: boolean }) => {
      if (options.plan) {
        if (command.length) throw new Error("package-manager --plan does not execute a command");
        console.log(JSON.stringify(packageManagerInstallationPlan(process.cwd(), distributionRoot(root))));
        return;
      }
      if (!command.length) throw new Error("package-manager execution requires a command");
      const invocation = await packageManagerCommand(process.cwd(), distributionRoot(root));
      withCacheSizeChanges([process.env.WORKBENCH_BUILD_DIR, process.env.WORKBENCH_DEPENDENCIES_DIR], () => {
        execute(required(invocation[0], "package-manager execution needs a command"), [
          ...invocation.slice(1),
          ...command,
        ]);
      });
    });
  registerCommand(program, "php-coverage-exec", { hidden: true })
    .argument("<command...>")
    .action((command: string[]) => executePhpCoverage(process.cwd(), distributionRoot(root), command));

  registerCommand(program, "native-image-inputs", { hidden: true }).action(() =>
    prepareNativeImageInputs(process.cwd(), distributionRoot(root)),
  );

  registerCommand(program, "php-package-manager-exec", { hidden: true })
    .option("--bootstrap-path", "Verify and print the Composer PHAR used for API analysis")
    .argument("[command...]")
    .action(async (command: string[], options: { bootstrapPath?: boolean }) => {
      if (options.bootstrapPath) console.log(await composerBootstrap(process.cwd(), distributionRoot(root)));
      else {
        if (!command.length) throw new Error("Composer execution requires a command");
        await executeComposer(process.cwd(), distributionRoot(root), command);
      }
    });

  registerCommand(program, "ruby-package-manager-exec", { hidden: true })
    .argument("<command...>")
    .action((command: string[]) => executeBundler(process.cwd(), distributionRoot(root), command));
  registerCommand(program, "native-assets-prune", { hidden: true })
    .option("--check", "Reject obsolete entries without changing files")
    .option("--plan", "Emit the read-only replacement plan as JSON")
    .option("--apply", "Publish a formatted replacement received as JSON on stdin")
    .action((options: { check?: boolean; plan?: boolean; apply?: boolean }) => {
      if ([options.check, options.plan, options.apply].filter(Boolean).length > 1)
        throw new Error("native asset pruning modes are mutually exclusive");
      const distribution = distributionRoot(root);
      if (options.plan) {
        console.log(JSON.stringify(nativeAssetPruningPlan(distribution)));
        return;
      }
      const replacement = options.apply
        ? (JSON.parse(readFileSync(0, "utf8")) as { original: string; contents: string })
        : undefined;
      const removed = replacement
        ? publishNativeAssets(distribution, replacement.original, replacement.contents)
        : pruneNativeAssets(distribution, options.check);
      for (const entry of removed) console.log(`Removed obsolete native asset ${entry}.`);
    });
  registerCommand(program, "native-exec", { hidden: true })
    .argument("<directory>")
    .argument("<command...>")
    .action((directory: string, command: string[]) => {
      withToolCacheUse(
        () => {
          const paths = buildPaths(
            root,
            directory,
            process.env.WORKBENCH_DEVCONTAINER === "1" ? "devcontainer" : "native",
          );
          prepareBuild(paths);
          if (paths.external && paths.identity.environment === "native") {
            const tools = selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || ".");
            recordResultTools({
              directory: paths.directory,
              storageRoot: paths.storageRoot,
              identity: paths.identity,
              kind: "builds",
              tools,
            });
          }
          const guarded = guardToolchains(directory, command);
          withCacheSizeChanges([paths.directory, paths.dependencies], () => {
            execute(required(guarded[0], "expected guarded[0]"), guarded.slice(1), {
              cwd: directory,
              env: nativeCheckEnvironment(root, paths.projectDirectory, {}, undefined, paths),
            });
          });
        },
        selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || "."),
      );
    });
  registerCommand(program, "managed-exec", { hidden: true })
    .argument("<builder>")
    .argument("<directory>")
    .argument("<command...>")
    .action((builder: string, directory: string, command: string[]) => {
      if (builder !== "nix" && builder !== "guix") throw new Error("managed-exec requires nix or guix");
      runCommand(directory, "managed container command", command, builder, root);
    });
  registerCommand(program, "devcontainer-exec", { hidden: true })
    .argument("<repository>")
    .argument("<directory>")
    .argument("<command...>")
    .action((repository: string, directory: string, command: string[]) =>
      executeDevcontainer(repository, directory, command),
    );
  registerCommand(program, "vcpkg-prepare", { hidden: true })
    .argument("<directory>")
    .argument("<build>")
    .addOption(new Option("--compiler <family>").choices(compilerFamilies))
    .option("--sanitizers", "Match dependency instrumentation where required by the target ABI")
    .action((directory: string, build: string, options: { compiler?: CompilerFamily; sanitizers?: boolean }) => {
      prepareVcpkg(directory, build, options.compiler, options.sanitizers);
    });
  registerCommand(program, "miri-exec", { hidden: true })
    .argument("<arguments...>")
    .action((args: string[]) => {
      runMiri(process.cwd(), args);
    });
}
