import { captureOwnedChild, runOwnedChild } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";
import { setImmediate as yieldTurn } from "node:timers/promises";

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
  const settings = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    signal: new AbortController().signal,
    shutdown: "drain" as const,
    inheritInput: !options.capture,
  };
  if (options.capture) {
    const outcome = await captureOwnedChild(command, args, settings, capturedOutputLimit);
    const problem = processFailure(command, outcome, outcome);
    if (problem) throw problem;
    return outcome.stdout;
  }
  const outcome = await runOwnedChild(command, args, settings);
  const problem = processFailure(command, outcome);
  if (problem) throw problem;
  return "";
}
