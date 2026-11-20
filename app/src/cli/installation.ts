import { Option, type Command } from "commander";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { syncLocalContextIndex } from "../core/collections/local-context.js";
import { userConfigValues } from "../core/configuration/user-config.js";
import { executingToolPin, readToolPin } from "../core/distribution/launcher-identity.js";
import { archiveInstallationEnvironment } from "../core/distribution/distribution-identity.js";
import {
  installArchiveRelease,
  recoverArchiveRelease,
  updateArchiveRelease,
} from "../core/distribution/installed-release.js";
import {
  activateLaunchdRelease,
  installLaunchAgent,
  installLaunchDaemon,
  recoverLaunchdRelease,
  removeLaunchdService,
} from "../core/distribution/launchd-service.js";
import {
  activateSystemdRelease,
  installSystemdService,
  recoverSystemdRelease,
  removeSystemdService,
  serviceScopes,
  type ServiceScope,
} from "../core/distribution/systemd-service.js";
import { updateWorkbench } from "../core/distribution/update.js";
import {
  activateWindowsRelease,
  installWindowsService,
  recoverWindowsRelease,
  removeWindowsService,
} from "../core/distribution/windows-service.js";
import { installWindowsUserService, removeWindowsUserService } from "../core/distribution/windows-user-service.js";
import { distributionRoot } from "../core/projects/project-context.js";
import { ownedPath } from "../core/runtime/paths.js";
import { toolSpecification, type ToolPin } from "../core/toolchains/tool-pin.js";
import { registerCommand } from "./commands.js";
import { detectedCompletionShell, installCompletion } from "./completion.js";

const marker = "// Workbench-owned launcher.\n";
function launchDirectory(directory?: string): string {
  return resolve(
    directory ??
      (process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ??
              (() => {
                throw new Error("LOCALAPPDATA is required");
              })(),
            "workbench/bin",
          )
        : join(homedir(), ".local/bin")),
  );
}

function finishInstallation(file: string, selected?: string): void {
  syncLocalContextIndex();
  console.log(`Installed ${file}${selected ? ` (${selected})` : ""}.`);
  const directory = dirname(file);
  if (!(process.env.PATH ?? "").split(delimiter).some((entry) => resolve(entry) === directory))
    console.log(`Add ${directory} to PATH to use workbench.`);
  const shell = detectedCompletionShell();
  if (shell) installCompletion(shell);
  else console.log("Install completion for your shell with: workbench completion install SHELL");
}

export function installLauncher(
  root: string,
  options: { directory?: string; repository?: string; revision?: string },
): string {
  const distribution = distributionRoot(root);
  const pin: ToolPin | undefined =
    options.repository && options.revision
      ? { repository: options.repository, revision: options.revision }
      : (readToolPin(root) ?? executingToolPin(distribution));
  if (!!options.repository !== !!options.revision || !pin)
    throw new Error("supply --repository and --revision, or install using a project-pinned Workbench");
  toolSpecification(pin);
  const directory = launchDirectory(options.directory);
  const file = ownedPath(directory, process.platform === "win32" ? "workbench.cjs" : "workbench");
  mkdirSync(directory, { recursive: true });
  if (
    existsSync(file) &&
    // codeql[js/file-system-race] Explicit installation checks the user-owned launcher; this read is not an authorization check for an untrusted writer.
    (!lstatSync(file).isFile() || !readFileSync(file, "utf8").startsWith(`#!/usr/bin/env node\n${marker}`))
  )
    throw new Error(`preserving an existing executable: ${file}`);
  const shim = process.platform === "win32" ? ownedPath(directory, "workbench.cmd") : undefined;
  const shimContents = '@rem Workbench-owned launcher\r\n@node "%~dp0workbench.cjs" %*\r\n';
  if (shim && existsSync(shim) && readFileSync(shim, "utf8") !== shimContents)
    throw new Error(`preserving existing launcher: ${shim}`);
  const bytes = readFileSync(join(distribution, "bundle/launcher.cjs"), "utf8");
  // codeql[js/file-system-race] The explicit install operation replaces only the marked launcher in the selected user-owned directory.
  writeFileSync(
    file,
    `#!/usr/bin/env node\n${marker}${bytes}\nmodule.exports.launch(process.argv.slice(2), ${JSON.stringify(pin)}).catch(error => { console.error(module.exports.formatFailure(error)); process.exitCode = 1; });\n`,
    { mode: 0o755 },
  );
  if (process.platform !== "win32") chmodSync(file, 0o755);
  if (shim) writeFileSync(shim, shimContents);
  finishInstallation(file, toolSpecification(pin));
  return file;
}
export function registerInstallationCommands(program: Command, root: string): void {
  registerCommand(program, "install")
    .description("Install Workbench from a verified release archive or an exact Git commit")
    .option("--user", "Install for this user (default)")
    .option("--directory <path>", "Select the executable directory; system locations need administrator access")
    .option("--repository <url>", "Default Git repository URL (HTTPS or SSH)")
    .option("--revision <commit>", "Default full Git commit")
    .addOption(
      new Option("--archive <path>", "Install a verified release archive").conflicts([
        "repository",
        "revision",
        "service",
      ]),
    )
    .option("--sha256 <checksum>", "Expected SHA-256 of the selected release archive")
    .addOption(
      new Option("--repair", "Restore the launcher for an existing verified archive installation").conflicts([
        "repository",
        "revision",
        "service",
      ]),
    )
    .addOption(
      new Option("--service <scope>", "Register this installed release with the native service manager")
        .choices(serviceScopes)
        .conflicts(["user", "directory", "repository", "revision", "archive", "sha256"]),
    )
    .option("--port <port>", "Set the installed service's loopback port", Number)
    .action(
      async (options: {
        directory?: string;
        repository?: string;
        revision?: string;
        service?: ServiceScope;
        port?: number;
        archive?: string;
        sha256?: string;
        repair?: boolean;
      }) => {
        if (options.service) {
          const distribution = distributionRoot(root);
          if (process.platform === "win32") {
            if (options.service === "user") {
              const task = await installWindowsUserService(
                distribution,
                options.port ?? Number(userConfigValues()["daemon.private_port"]),
              );
              console.log(`Registered ${task}. It starts when you sign in.`);
              console.log(`Start it now with schtasks /Run /TN ${task}.`);
              return;
            }
            const service = await installWindowsService(
              distribution,
              options.port ?? Number(userConfigValues()["daemon.system_port"]),
            );
            console.log(
              `Registered ${service}. Start it with Start-Service ${service} from an administrator terminal.`,
            );
            return;
          }
          const result =
            process.platform === "darwin"
              ? options.service === "system"
                ? installLaunchDaemon(distribution, options.port)
                : installLaunchAgent(distribution, options.port)
              : installSystemdService(distribution, options.service, options.port);
          console.log("Registered " + result.path);
          console.log("Start it with " + result.command);
          return;
        }
        if (options.port !== undefined) throw new Error("--port requires --service");
        if (options.archive || options.sha256 || options.repair) {
          if (!options.archive || !options.sha256) throw new Error("Supply both --archive and --sha256");
          const file = await installArchiveRelease(
            launchDirectory(options.directory),
            resolve(options.archive),
            options.sha256,
            options.repair,
          );
          if (options.repair) console.log(`Repaired ${file}.`);
          else finishInstallation(file);
          return;
        }
        installLauncher(root, options);
      },
    );
  registerCommand(program, "update")
    .description("Activate a verified application release; collection updates are separate")
    .argument("[revision]", "Full Git commit for a checkout-managed executable pin")
    .addOption(new Option("--archive <path>", "Activate a verified release archive").conflicts(["rollback", "recover"]))
    .addOption(
      new Option("--sha256 <checksum>", "Expected SHA-256 of the release archive").conflicts(["rollback", "recover"]),
    )
    .addOption(new Option("--rollback", "Select the previous verified release").conflicts("recover"))
    .option("--recover", "Restore the verified release after an interrupted update")
    .action(
      async (
        revision: string | undefined,
        options: { archive?: string; sha256?: string; rollback?: boolean; recover?: boolean },
      ) => {
        if (!process.env[archiveInstallationEnvironment]) {
          if (options.archive || options.sha256 || options.rollback || options.recover)
            throw new Error("Run the installed Workbench launcher to replace a release archive");
          await updateWorkbench(root, revision);
          return;
        }
        if (revision || (!options.rollback && !options.recover && (!options.archive || !options.sha256)))
          throw new Error("Supply --archive and --sha256, or use --rollback or --recover");
        const { assertReleaseServicesIdle, launchDaemonReady, privateServiceReady } =
          await import("../server/runtime.js");
        const launchdReady =
          process.geteuid?.() === 0
            ? (distribution: string, pid: number, _state: string, signal: AbortSignal) =>
                launchDaemonReady(distribution, pid, signal)
            : privateServiceReady;
        if (options.recover) {
          const restored = await recoverArchiveRelease(async (launcher, restore, service, previous, permitStart) => {
            if (process.platform === "win32") {
              await recoverWindowsRelease(launcher, restore, service, assertReleaseServicesIdle);
              return;
            }
            if (process.platform === "darwin")
              await recoverLaunchdRelease(
                launcher,
                restore,
                service,
                previous,
                permitStart,
                assertReleaseServicesIdle,
                launchdReady,
              );
            else recoverSystemdRelease(launcher, restore, service, assertReleaseServicesIdle);
          });
          console.log(`Active Workbench release ${toolSpecification(restored)}.`);
          return;
        }
        const release = options.rollback
          ? "rollback"
          : { source: resolve(options.archive ?? ""), sha256: options.sha256 ?? "" };
        const distribution = distributionRoot(root);
        const selected = await updateArchiveRelease(distribution, release, async (transition) => {
          if (process.platform === "win32") {
            await activateWindowsRelease(transition, assertReleaseServicesIdle);
            return;
          }
          if (process.platform === "darwin")
            await activateLaunchdRelease(transition, assertReleaseServicesIdle, launchdReady);
          else activateSystemdRelease(transition, assertReleaseServicesIdle);
        });
        console.log(`Active Workbench release ${toolSpecification(selected)}.`);
      },
    );
  registerCommand(program, "uninstall")
    .description("Remove an owned native service registration")
    .addOption(
      new Option("--service <scope>", "Remove the selected native service registration")
        .choices(serviceScopes)
        .makeOptionMandatory(),
    )
    .action(async ({ service }: { service: ServiceScope }) => {
      const path =
        process.platform === "win32"
          ? service === "system"
            ? await removeWindowsService(distributionRoot(root))
            : await removeWindowsUserService(distributionRoot(root))
          : process.platform === "darwin"
            ? await removeLaunchdService(service)
            : removeSystemdService(service);
      console.log(path ? "Removed " + path : `Workbench ${service} service is already unregistered.`);
    });
}
