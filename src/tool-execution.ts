import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { environmentValue } from "./host-environment.js";
import { required } from "./invariants.js";
import { processFailure } from "../scripts/process-outcome.mjs";

export function commandInvocation(command: string, args: string[], env = process.env, cwd = process.cwd()): string[] {
  if (process.platform !== "win32" || /\.(?:exe|com)$/i.test(command)) return [command, ...args];
  const directories =
    isAbsolute(command) || /[/\\]/.test(command)
      ? [cwd]
      : [cwd, ...(environmentValue(env, "PATH") ?? "").split(delimiter)];
  // Launch native programs directly: an MSYS intermediary can detach a private UTF-8 console.
  // Search each directory in order so a script earlier on PATH retains its authority.
  for (const directory of directories) {
    for (const suffix of ["", ...(environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")]) {
      const path = resolve(directory, command + suffix);
      try {
        if (!statSync(path).isFile()) continue;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      return /\.(?:exe|com)$/i.test(path)
        ? [path, ...args]
        : ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", path.replaceAll("\\", "/"), ...args];
    }
  }
  return ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", command.replaceAll("\\", "/"), ...args];
}

export function execute(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; maxBuffer?: number; timeout?: number } = {},
): string {
  const { capture, ...rest } = options;
  const invocation = commandInvocation(command, args, rest.env, rest.cwd);
  const result = spawnSync(required(invocation[0], "tool execution needs a command"), invocation.slice(1), {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...rest,
  });
  const failure = processFailure(
    command,
    result,
    capture ? { stdout: result.stdout, stderr: result.stderr } : undefined,
  );
  if (failure) throw failure;
  return capture ? result.stdout : "";
}
