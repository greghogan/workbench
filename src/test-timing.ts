import { required } from "./invariants.js";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

/** Observe an admitted command. Slow execution never changes its exit status. */
export async function observeCommand(command: string[], warnSeconds: number): Promise<void> {
  if (!command.length || !Number.isFinite(warnSeconds) || warnSeconds <= 0)
    throw new Error("timing requires a positive warn_seconds value and a command");
  const started = performance.now();
  const child = spawn(required(command[0], "expected command[0]"), command.slice(1), { stdio: "inherit" });
  const warning = setTimeout(() => {
    console.error(`SLOW suite: exceeded ${String(warnSeconds)}s; advisory only. Account for host resources.`);
  }, warnSeconds * 1000);
  // The child shares the terminal's process group. Forward signals sent to this process alone too.
  const interrupt = () => {
    child.kill("SIGINT");
  };
  const terminate = () => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const seconds = (performance.now() - started) / 1000;
    console.log(
      `Suite: ${seconds.toFixed(3)}s (soft cap ${String(warnSeconds)}s${seconds > warnSeconds ? "; exceeded" : ""})`,
    );
    if (result.code !== 0)
      throw new Error(`suite failed with ${result.signal ?? `exit status ${String(result.code)}`}`);
  } finally {
    clearTimeout(warning);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
