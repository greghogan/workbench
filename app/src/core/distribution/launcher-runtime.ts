import { spawn } from "node:child_process";

/** Keep ownership until a dispatched CLI exits, forwarding interruption to its cleanup handlers. */
export async function launchProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<void> {
  await new Promise<void>((finish, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const interrupt = () => child.kill("SIGINT"),
      terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
      finish();
    });
  });
}

/** Managed environments and explicit compatibility runs own their interpreter. */
export function ownsStartupRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(
    Boolean(env.GUIX_ENVIRONMENT) ||
    Boolean(env.IN_NIX_SHELL) ||
    (Boolean(env.WORKBENCH_SHELL_ENVIRONMENT) && env.WORKBENCH_SHELL_ENVIRONMENT !== "native") ||
    env.WORKBENCH_PREPARED === "1" ||
    env.WORKBENCH_DEVCONTAINER === "1" ||
    env.WORKBENCH_COMPATIBILITY_RUNTIME === "node"
  );
}
