import { performance } from "node:perf_hooks";
import { plainOutput } from "./presentation.js";
import { safeOutput, fitTerminalText } from "./terminal-text.js";

export interface CachePruneObserver {
  begin(total: number): void;
  start(label: string): void;
  complete(): void;
}

/** Notify only around the actual removal, after its ownership preflight has passed. */
export async function pruneItem(
  label: string,
  remove: () => Promise<void>,
  progress?: CachePruneObserver,
): Promise<void> {
  progress?.start(label);
  await remove();
  progress?.complete();
}

interface ProgressOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

/** Count deletion units rather than estimating progress from their byte sizes. */
export class CachePruneProgress implements CachePruneObserver {
  private total = 0;
  private completed = 0;
  private label = "validating ownership";
  private started: number | undefined;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly interactive: boolean;
  constructor(
    private readonly output: ProgressOutput = process.stdout,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.interactive = output.isTTY === true && process.env.TERM !== "dumb" && !plainOutput();
  }
  begin(total: number): void {
    this.total = total;
    this.started = this.now();
    if (this.interactive) {
      this.draw();
      this.timer = setInterval(() => {
        this.draw();
      }, 100);
      this.timer.unref();
    } else this.output.write(`Deleting ${String(total)} cache items…\n`);
  }
  start(label: string): void {
    this.label = label;
    this.draw();
  }
  complete(): void {
    this.completed++;
    this.draw();
  }
  close(success: boolean): void {
    if (this.started === undefined) return;
    if (this.timer) clearInterval(this.timer);
    if (this.interactive) this.output.write("\r\u001b[2K");
    this.output.write(
      `${success ? "Removed" : "Stopped after removing"} ${String(this.completed)}/${String(this.total)} cache items in ${this.elapsed()} s.\n`,
    );
    this.started = undefined;
  }
  private elapsed(): string {
    return ((this.now() - (this.started ?? this.now())) / 1000).toFixed(1);
  }
  private draw(): void {
    if (!this.interactive) return;
    const text = `${["|", "/", "-", "\\"][this.frame++ % 4] ?? "|"} Deleting ${String(this.completed)}/${String(this.total)} cache items (${this.elapsed()} s): ${safeOutput(this.label).replaceAll("\n", " ").replaceAll("\t", " ")}`;
    // Byte-based truncation is conservative for non-ASCII paths: never wrap into another terminal row.
    const columns = this.output.columns ?? 80;
    const width = Math.max(1, (columns > 0 ? columns : 80) - 1);
    const fitted = fitTerminalText(text, width);
    this.output.write(`\r\u001b[2K${fitted}`);
  }
}
