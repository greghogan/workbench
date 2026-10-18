import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { quote } from "./toolchains.js";
import { developmentEnvironment, type DevelopmentEnvironment } from "./environments.js";

const powershell = (script: string) => [
  "pwsh",
  "-NoLogo",
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];

/** Select inside the execution environment: a Linux container never inherits the host's Windows shell choice. */
export function interactiveShell(platform = process.platform, env = process.env): string[] {
  const preferred = env.SHELL === "" ? undefined : env.SHELL;
  const shell = platform === "win32" ? "pwsh" : (preferred ?? (platform === "darwin" ? "/bin/zsh" : "bash"));
  const family = basename(shell)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  switch (family) {
    case "bash":
      return [shell, "--noprofile", "--norc", "-i"];
    case "zsh":
      return [shell, "-f", "-i"];
    case "fish":
      return [shell, "--no-config", "--interactive"];
    case "csh":
    case "tcsh":
      return [shell, "-f", "-i"];
    case "sh":
    case "dash":
    case "ksh":
      return [shell, "-i"];
    case "pwsh":
      return [
        shell,
        "-NoExit",
        ...powershell(`function global:workbench { & $env:WORKBENCH_SHELL_NODE (Join-Path $env:WORKBENCH_DISTRIBUTION_ROOT 'bundle/main.cjs') @args }
function global:prompt { 'workbench[' + $env:WORKBENCH_SHELL_LABEL + '] ' + $executionContext.SessionState.Path.CurrentLocation + '> ' }`).slice(
          1,
        ),
      ];
    default:
      throw new Error(
        `unsupported interactive shell '${shell}'; set SHELL to bash, zsh, fish, sh, dash, ksh, csh, tcsh, or pwsh`,
      );
  }
}

/** PowerShell receives literal strings, including for Windows .cmd tools; no command text is interpolated. */
export function shellCommand(command: string[], platform = process.platform): string[] {
  if (platform !== "win32") return command;
  const literals = command.map((argument) => `'${argument.replaceAll("'", "''")}'`).join(",");
  return [
    "pwsh",
    "-NonInteractive",
    ...powershell(`$global:LASTEXITCODE = 0
$values = @(${literals})
$executable = $values[0]
$arguments = @($values | Select-Object -Skip 1)
& $executable @arguments
$ok = $?
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $ok) { exit 1 }`).slice(1),
  ];
}

export interface ShellContext {
  path: string;
  environment: DevelopmentEnvironment;
  profile: string;
  toolchain: string;
}

export interface ShellSessionRequest extends ShellContext {
  command: string[];
  plain: boolean;
  noColor: boolean;
}

/** Validate the same request contract produced before entry into the selected environment. */
export function decodeShellSession(text: string, roots: readonly string[]): ShellSessionRequest {
  const value: unknown = JSON.parse(text);
  const strings = (parts: unknown): parts is string[] =>
    Array.isArray(parts) && parts.every((part: unknown) => typeof part === "string");
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !roots.includes(value.path) ||
    !("environment" in value) ||
    typeof value.environment !== "string" ||
    !("profile" in value) ||
    typeof value.profile !== "string" ||
    !("toolchain" in value) ||
    typeof value.toolchain !== "string" ||
    !("command" in value) ||
    !strings(value.command) ||
    !("plain" in value) ||
    typeof value.plain !== "boolean" ||
    !("noColor" in value) ||
    typeof value.noColor !== "boolean"
  )
    throw new Error("invalid shell session context");
  return {
    path: value.path,
    environment: developmentEnvironment(value.environment, "shell session environment"),
    profile: value.profile,
    toolchain: value.toolchain,
    command: value.command,
    plain: value.plain,
    noColor: value.noColor,
  };
}

/** A private launcher keeps nested shells on the selected distribution without exported Bash functions. */
export async function shellSession(
  root: string,
  distribution: string,
  context: ShellContext,
  command: string[],
): Promise<number> {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-shell-"));
  try {
    const bin = join(temporary, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const launcher = join(distribution, "bundle/main.cjs");
    if (process.platform === "win32")
      writeFileSync(
        join(bin, "workbench.cmd"),
        '@echo off\r\n"%WORKBENCH_SHELL_NODE%" "%WORKBENCH_DISTRIBUTION_ROOT%\\bundle\\main.cjs" %*\r\n',
      );
    // Also support explicitly selected Git Bash sessions on Windows.
    writeFileSync(
      join(bin, "workbench"),
      `#!/bin/sh\nexec ${quote(process.execPath.replaceAll("\\", "/"))} ${quote(launcher.replaceAll("\\", "/"))} "$@"\n`,
      {
        mode: 0o700,
      },
    );
    const label = context.profile || context.environment;
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_SHELL_ENVIRONMENT: context.environment,
      WORKBENCH_DEVELOPMENT_PROFILE: context.profile,
      WORKBENCH_TOOLCHAIN: context.toolchain,
      WORKBENCH_TOOLCHAIN_ROOT: root,
      WORKBENCH_SHELL_ROOT: resolve(root, context.path),
      WORKBENCH_SHELL_NODE: process.execPath,
      WORKBENCH_SHELL_LABEL: label,
      PS1: `workbench[${label}] $ `,
    };
    for (const key of Object.keys(env))
      if (key !== "PATH" && key.toUpperCase() === "PATH") Reflect.deleteProperty(env, key);
    // sh/ksh can otherwise load personal startup code through these variables despite explicit shell flags.
    Reflect.deleteProperty(env, "ENV");
    Reflect.deleteProperty(env, "BASH_ENV");
    const invocation = command.length ? shellCommand(command) : interactiveShell(process.platform, env);
    const [executable, ...args] = invocation;
    if (!executable) throw new Error("shell session requires a command");
    return await new Promise<number>((finish, reject) => {
      const child = spawn(executable, args, { cwd: resolve(root, context.path), env, stdio: "inherit" });
      const interrupt = () => {
        child.kill("SIGINT");
      };
      const terminate = () => {
        child.kill("SIGTERM");
      };
      const cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      child.once("error", (error) => {
        cleanup();
        reject(new Error(`cannot start ${executable}: ${error.message}`, { cause: error }));
      });
      child.once("exit", (code, signal) => {
        cleanup();
        finish(code ?? (signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
