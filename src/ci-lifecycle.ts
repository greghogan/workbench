import { spawn } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { formatByteCount } from "./byte-size.js";

const capturedOutputLimit = 16 * 1024 * 1024;

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export class CIInterrupted extends Error {
  constructor() {
    super("Stopped admitting work; active mutations were allowed to finish");
  }
}

/** One signal scope spans preparation, job admission, draining, and cleanup. */
export class CILifecycle {
  interrupted = false;
  private readonly interrupt = () => {
    this.interrupted = true;
  };

  constructor(private readonly signals: SignalSource = process) {
    signals.on("SIGINT", this.interrupt);
    signals.on("SIGTERM", this.interrupt);
  }

  async ready(): Promise<boolean> {
    await yieldTurn();
    return !this.interrupted;
  }

  async checkpoint(): Promise<void> {
    if (!(await this.ready())) throw new CIInterrupted();
  }

  close(): void {
    this.signals.removeListener("SIGINT", this.interrupt);
    this.signals.removeListener("SIGTERM", this.interrupt);
  }
}

/** Keep the event loop responsive and drain admitted commands, including during shutdown. */
export async function executeCI(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<string> {
  const { capture, ...settings } = options;
  const child = spawn(command, args, {
    ...settings,
    detached: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: Error | undefined;
  const collect = (buffers: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= capturedOutputLimit) buffers.push(chunk);
    else failure ??= new Error(`${command}: captured output exceeds ${formatByteCount(capturedOutputLimit)} bytes`);
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (failure || status.code !== 0)
    throw new Error(
      `${command} failed: ${failure?.message ?? (Buffer.concat(stderr).toString().trim() || `exit ${String(status.code ?? status.signal)}`)}`,
      failure ? { cause: failure } : undefined,
    );
  return capture ? Buffer.concat(stdout).toString() : "";
}
