import { Command, Option } from "commander";
import { resolve } from "node:path";
import { registerCommand } from "./commands.js";
import { developmentImages, runOfflineOperation, type ImageOptions } from "../development-images.js";
import { DevelopmentLock, inspectDevelopmentLocks, recoverDevelopmentLock } from "../development-locks.js";
import { listDevelopment, useDevelopment } from "../development.js";
import { installContainerTools } from "../native-tools.js";
import {
  offlineImageReference,
  offlineProfile,
  prepareOfflineProfile,
  publishOfflineProfile,
  verifyOfflineProfile,
} from "../offline-profiles.js";
import { configurePresentation } from "../presentation.js";
import { readLanguageRoots } from "../project-configuration.js";
import { distributionRoot } from "../project-context.js";
import { decodeShellSession, shellSession } from "../shell-session.js";
import { developmentShell } from "../shell.js";
import { resolveCheckCommand } from "../toolchains.js";
import { ciDestination } from "../ci-destinations.js";
import { ciImageReference } from "../ci-images.js";
export function registerDevelopmentCommands(program: Command, root: string): void {
  const development = registerCommand(program, "development")
    .description("Inspect named development profiles and local selection")
    .option("--json")
    .action((options: { json?: boolean }) => {
      listDevelopment(root, options.json);
    });
  development
    .command("images")
    .description("Inspect development images and select preparation and publication in a terminal")
    .argument("[profiles...]", "Configured prepared profiles; defaults to all")
    .option("--list", "Show image status without preparation or publication prompts")
    .option("--require", "Check registry availability without prompts; fail if any selected image is unavailable")
    .option("--json", "Print image references and availability as JSON without prompts")
    .addOption(
      new Option("--architecture <architecture>", "Inspect images for this Linux architecture").choices([
        "x64",
        "arm64",
      ]),
    )
    .action(async (profiles: string[], options: ImageOptions) => developmentImages(root, profiles, options));
  development
    .command("locks")
    .description("Inspect preparation locks, ownership, recovery digests, and active work")
    .argument("<profile>")
    .action((profile: string) => {
      console.log(JSON.stringify(inspectDevelopmentLocks(root, profile), null, 2));
    });
  development
    .command("recover")
    .description("Recover an inspected preparation lock only after its owner and work have stopped")
    .argument("<profile>")
    .addOption(
      new Option("--lock <kind>", "Select the preparation lock")
        .choices(Object.values(DevelopmentLock))
        .default(DevelopmentLock.Profile),
    )
    .requiredOption("--expect <digest>", "Exact lock digest returned by development locks")
    .action((profile: string, options: { lock: DevelopmentLock; expect: string }) => {
      recoverDevelopmentLock(root, profile, options.lock, options.expect);
      console.log(`Recovered ${options.lock} lock for ${profile}.`);
    });
  for (const operation of ["prepare", "verify", "publish"] as const) {
    const command = development
      .command(operation)
      .description(
        operation === "publish"
          ? "Push a verified development image and verify its registry digest"
          : operation === "prepare"
            ? "Build an image online, then verify offline without host dependency caches"
            : "Verify a prepared image without networking or host dependency caches",
      )
      .argument("<profile>");
    command.addOption(
      new Option(
        "--architecture <architecture>",
        "Linux target architecture; foreign execution uses configured binfmt",
      ).choices(["x64", "arm64"]),
    );
    if (operation === "publish")
      command
        .option("--image <reference>", "Override the configured registry repository and input tag")
        .option("--destination <remote>", "Publish to this CI destination's declared registry");
    if (operation === "verify")
      command.option("--image <id>", "Qualify and accept this immutable image for the selected architecture");
    if (operation === "prepare")
      command
        .option("--build", "Build locally without reusing a registry image")
        .option("--fresh", "Execute offline verification even when matching local evidence exists")
        .option(
          "--assemble-only",
          "Assemble without acceptance; offline verification is required before use or publication",
        )
        .option("--pull-only", "Require the configured registry image; never build locally");
    command.action(
      (
        profile: string,
        options: {
          image?: string;
          build?: boolean;
          pullOnly?: boolean;
          fresh?: boolean;
          architecture?: string;
          assembleOnly?: boolean;
          destination?: string;
        },
      ) => {
        if (options.destination && options.image) throw new Error("Select either --destination or --image");
        const image = options.destination
          ? ciImageReference(
              root,
              profile,
              options.architecture ?? process.arch,
              ciDestination(root, options.destination),
            )
          : options.image;
        runOfflineOperation(root, operation, profile, { ...options, ...(image ? { image } : {}) });
      },
    );
  }
  registerCommand(program, "offline-exec", { hidden: true })
    .argument("<operation>")
    .argument("<profile>")
    .argument("[image]")
    .option("--build")
    .option("--fresh")
    .option("--assemble-only")
    .option("--pull-only")
    .addOption(new Option("--architecture <architecture>").choices(["x64", "arm64"]))
    .action(
      async (
        operation: string,
        profile: string,
        image: string | undefined,
        options: {
          build?: boolean;
          pullOnly?: boolean;
          fresh?: boolean;
          architecture?: string;
          assembleOnly?: boolean;
        },
      ) => {
        if (operation === "prepare" || operation === "verify" || operation === "publish") {
          offlineProfile(root, profile);
          await installContainerTools(root);
        }
        if (operation === "prepare") await prepareOfflineProfile(root, profile, options);
        else if (operation === "verify") await verifyOfflineProfile(root, profile, image, options.architecture);
        else if (operation === "publish")
          await publishOfflineProfile(
            root,
            profile,
            image ?? offlineImageReference(root, profile, options.architecture),
            options.architecture,
          );
        else throw new Error("Unknown offline image operation");
      },
    );
  development
    .command("use")
    .description("Select an ignored local development profile; prompt when omitted")
    .argument("[profile]")
    .addOption(
      new Option(
        "--workspace <workspace>",
        "Select the local execution workspace independently of the builder",
      ).choices(["host", "devcontainer"]),
    )
    .action(async (profile: string | undefined, options: { workspace?: string }) => {
      await useDevelopment(root, profile, options.workspace);
    });
  registerCommand(program, "shell")
    .description("Use the selected environment and platform shell, or run a literal command")
    .option("--path <path>", "Registered language root relative to the repository", ".")
    .option("--profile <profile>", "Select a named development profile")
    .addOption(
      new Option("--workspace <workspace>", "Override the profile's workspace").choices(["host", "devcontainer"]),
    )
    .option("--toolchain <name>", "Select a named native compiler/runtime profile")
    .addOption(
      new Option("--environment <environment>", "Override the local selection").choices([
        "native",
        "nix",
        "guix",
        "devcontainer",
      ]),
    )
    .argument("[command...]", "Command and literal arguments after --; omit for an interactive shell")
    .action(
      (
        command: string[],
        options: { path: string; environment?: string; profile?: string; toolchain?: string; workspace?: string },
      ) =>
        developmentShell(
          root,
          options.path,
          options.environment,
          command,
          options.profile,
          options.toolchain,
          options.workspace,
        ),
    );
  registerCommand(program, "shell-session", { hidden: true })
    .argument("<context>")
    .action(async (text: string) => {
      const value = decodeShellSession(
        text,
        readLanguageRoots(root).map((entry) => entry.path),
      );
      const command = resolveCheckCommand(resolve(root, value.path), value.command, distributionRoot(root));
      configurePresentation(value.plain, false);
      if (value.noColor) process.env.NO_COLOR = "1";
      process.exitCode = await shellSession(root, distributionRoot(root), value, command);
    });
}
