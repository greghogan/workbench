import { spawnSync } from "node:child_process";
import { required } from "./invariants.js";
import { processFailure } from "../scripts/process-outcome.mjs";

export function commandInvocation(command: string, args: string[]): string[] {
  return process.platform === "win32" && !/\.exe$/i.test(command)
    ? ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", command.replaceAll("\\", "/"), ...args]
    : [command, ...args];
}

export function execute(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; maxBuffer?: number; timeout?: number } = {},
): string {
  const { capture, ...rest } = options;
  // Git Bash supplies literal argument forwarding for Windows package-manager shims.
  const invocation = commandInvocation(command, args);
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
