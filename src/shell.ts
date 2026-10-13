import { resolve, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { readConfig, readLanguageRoots, distributionRoot } from "./core.js";
import {
  activeEnvironment,
  developmentEnvironment,
  executionPreference,
  selectedDevelopmentProfile,
  withDevelopmentSelection,
} from "./environments.js";
import { available, runCommand } from "./checks.js";
import { quote, resolveCheckCommand, distributionReference } from "./toolchains.js";
import { selectedToolProfile } from "./tool-profiles.js";

export function developmentShell(
  root: string,
  path: string,
  explicit?: string,
  command: string[] = [],
  profileName?: string,
  toolchain?: string,
): void {
  withDevelopmentSelection(root, explicit, profileName, () => {
    openShell(root, path, explicit, command, profileName, toolchain);
  });
}

function openShell(
  root: string,
  path: string,
  explicit: string | undefined,
  command: string[],
  profileName: string | undefined,
  toolchain: string | undefined,
): void {
  if (!readLanguageRoots(root).some((entry) => entry.path === path))
    throw new Error(`--path must name a registered language root: '${path}'`);
  const config = readConfig(root);
  const selected = developmentEnvironment(
    executionPreference(root, explicit, profileName) ?? config.checks?.environment ?? "native",
    "shell environment",
  );
  const directory = realpathSync(resolve(root, path));
  const tools = selectedToolProfile(directory, toolchain);
  if (tools && selected !== "native" && selected !== "devcontainer")
    throw new Error("native tool profiles do not override Nix or Guix tool versions");
  const active = activeEnvironment();
  if (active && active.environment !== "native")
    throw new Error("already inside a managed Workbench shell; run commands here or exit before opening another shell");
  const interactive = command.length === 0;
  if (interactive && !process.stdin.isTTY)
    throw new Error("an interactive shell needs a terminal; use 'workbench shell -- COMMAND ...' for automation");
  const distribution = distributionRoot(root);
  const profile = selectedDevelopmentProfile(root);
  const shellEnvironment = selected === "devcontainer" && profile ? profile.builder : selected;
  const shellCommand = interactive ? ["bash", "--noprofile", "--norc", "-i"] : resolveCheckCommand(directory, command);
  const script = [
    ...(selected === "devcontainer" ? [] : [`export WORKBENCH_PROJECT_ROOT=${quote(realpathSync(root))}`]),
    selected === "devcontainer"
      ? `export WORKBENCH_DISTRIBUTION_ROOT="$WORKBENCH_PROJECT_ROOT"/${quote(relative(root, distributionReference(root, distribution)).split(sep).join("/") || ".")}`
      : `export WORKBENCH_DISTRIBUTION_ROOT=${quote(distribution)}`,
    `export WORKBENCH_SHELL_ENVIRONMENT=${quote(shellEnvironment)}`,
    `export WORKBENCH_DEVELOPMENT_PROFILE=${quote(profile?.name ?? "")}`,
    `export WORKBENCH_TOOLCHAIN=${quote(tools?.name ?? "")}`,
    'export WORKBENCH_TOOLCHAIN_ROOT="$WORKBENCH_PROJECT_ROOT"',
    selected === "devcontainer"
      ? `export WORKBENCH_SHELL_ROOT="$WORKBENCH_PROJECT_ROOT"/${quote(path)}`
      : `export WORKBENCH_SHELL_ROOT=${quote(directory)}`,
    `export WORKBENCH_REQUIRE_BENCHCTL=${quote(available("benchctl") ? "1" : "0")}`,
    `export PS1=${quote(`workbench[${profile?.name ?? selected}] \\w\\$ `)}`,
    'workbench() { node "$WORKBENCH_DISTRIBUTION_ROOT/bundle/main.cjs" "$@"; }',
    "export -f workbench",
    'exec "$@"',
  ].join("\n");
  console.log(`Local environment: ${selected}; root: ${path}`);
  if (interactive && selected !== "native") {
    // Realize and verify the environment through the scheduler before giving a terminal to the user.
    // Idle interactive sessions must not retain a scheduler reservation.
    runCommand(directory, "prepare development environment", ["true"], true, selected, root);
  }
  runCommand(
    directory,
    "development shell",
    ["bash", "--noprofile", "--norc", "-eu", "-c", script, "workbench-shell", ...shellCommand],
    !interactive,
    selected,
    root,
    undefined,
    true,
    false,
    tools ? { toolchain: tools.name } : {},
  );
}
