import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readConfig, readLanguageRoots } from "./core.js";
import {
  activeEnvironment,
  developmentEnvironment,
  executionPreference,
  selectedDevelopmentProfile,
  withDevelopmentSelection,
} from "./environments.js";
import { runCommand, runCommandAsync } from "./checks.js";
import { CheckCancellation } from "./check-cancellation.js";
import { selectedToolProfile } from "./tool-profiles.js";
import type { ShellSessionRequest } from "./shell-session.js";
import { colorDisabled, plainOutput } from "./presentation.js";

export async function developmentShell(
  root: string,
  path: string,
  explicit?: string,
  command: string[] = [],
  profileName?: string,
  toolchain?: string,
  workspace?: string,
): Promise<void> {
  const cancellation = new CheckCancellation("Development shell");
  try {
    await withDevelopmentSelection(
      root,
      explicit,
      profileName,
      () => openShell(root, path, explicit, command, profileName, toolchain, cancellation),
      workspace,
    );
    cancellation.checkpoint();
  } finally {
    cancellation.close();
  }
}

async function openShell(
  root: string,
  path: string,
  explicit: string | undefined,
  command: string[],
  profileName: string | undefined,
  toolchain: string | undefined,
  cancellation: CheckCancellation,
): Promise<void> {
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
  const profile = selectedDevelopmentProfile(root);
  const shellEnvironment = selected === "devcontainer" && profile ? profile.builder : selected;
  const request: ShellSessionRequest = {
    path,
    environment: shellEnvironment,
    profile: profile?.name ?? "",
    toolchain: tools?.name ?? "",
    command,
    plain: plainOutput(),
    noColor: colorDisabled(),
  };
  const shellCommand = [
    "node",
    "-e",
    'require(process.env.WORKBENCH_DISTRIBUTION_ROOT + "/bundle/main.cjs")',
    "workbench-shell",
    "shell-session",
    JSON.stringify(request),
  ];
  console.log(`Local environment: ${selected}; root: ${path}`);
  if (interactive && selected !== "native") {
    // Realize and verify the environment before giving a terminal to the user.
    await runCommandAsync(cancellation, directory, "prepare development environment", ["true"], selected, root);
  }
  cancellation.checkpoint();
  if (!interactive) {
    await runCommandAsync(
      cancellation,
      directory,
      "development shell",
      shellCommand,
      selected,
      root,
      tools ? { toolchain: tools.name } : {},
    );
    return;
  }
  runCommand(
    directory,
    "development shell",
    shellCommand,
    selected,
    root,
    undefined,
    true,
    false,
    tools ? { toolchain: tools.name } : {},
  );
}
