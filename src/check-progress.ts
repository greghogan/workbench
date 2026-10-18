import { StringDecoder } from "node:string_decoder";
import { plainOutput } from "./presentation.js";
import { safeOutput, fitTerminalText as fit } from "./terminal-text.js";

export const checkEventPrefix = "WORKBENCH_CHECK_EVENT\t";

/** Bound line buffering while preserving split UTF-8 and progress records. Full bytes remain in the run log. */
export class CheckLines {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private skipping = false;
  constructor(
    private readonly line: (text: string) => void,
    private readonly longLine?: (text: string) => void,
  ) {}
  push(bytes: Buffer): void {
    this.accept(this.decoder.write(bytes));
  }
  end(): void {
    this.accept(this.decoder.end());
    if (this.pending && !this.skipping) this.line(this.pending);
    this.pending = "";
  }
  private accept(text: string): void {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const complete = part.endsWith("\n");
      if (!this.skipping) {
        if (this.pending.length + part.length > 65536) {
          this.longLine?.(this.pending + part);
          this.pending = "";
          this.skipping = true;
        } else this.pending += part;
      } else this.longLine?.(part);
      if (complete) {
        if (!this.skipping) this.line(this.pending.replace(/\r?\n$/, ""));
        this.pending = "";
        this.skipping = false;
      }
    }
  }
}

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (text: string) => unknown;
}

interface ActiveCheckGroup {
  label: string;
  started: number;
  task?: { key: string; label: string; started: number };
}

function runtime(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** Completed checks stay in scrollback; only the bounded active pane is redrawn. */
export class CheckProgress {
  private height = 0;
  private paused = false;
  private closed = false;
  private deferred: string[] = [];
  private readonly active = new Map<string, ActiveCheckGroup>();
  private readonly finished = new Set<string>();
  private failures = 0;
  private stopping = false;
  private readonly interactive: boolean;
  private readonly started: number;
  private refresh: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly total: number,
    private readonly output: ProgressStream = process.stdout,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.started = now();
    this.interactive = output.isTTY === true && process.env.TERM !== "dumb" && !plainOutput();
  }
  get completed(): number {
    return this.finished.size;
  }
  startGroup(id: string, label: string): void {
    if (this.closed) return;
    this.active.set(id, { label, started: this.now() });
    if (!this.interactive) this.message(`Starting ${label}`);
    this.updateRefresh();
    this.draw();
  }
  event(id: string, label: string, step: number, task: string, event: string): void {
    const key = `${id}:${String(step)}`;
    if (this.closed || this.finished.has(key)) return;
    const now = this.now();
    const group = this.active.get(id) ?? { label, started: now };
    this.active.set(id, group);
    if (event === "start") {
      group.task = { key, label: task, started: now };
      if (!this.interactive)
        this.message(`[${String(this.completed)}/${String(this.total)} completed] Running ${label}: ${task}`);
    } else {
      const elapsed = group.task?.key === key ? now - group.task.started : 0;
      this.finished.add(key);
      if (event === "fail") this.failures++;
      delete group.task;
      this.message(
        `[${String(this.completed)}/${String(this.total)} completed] ${event === "pass" ? "Passed" : "Failed"} ${label}: ${task} (${runtime(elapsed)})`,
      );
    }
    this.updateRefresh();
    this.draw();
  }
  finishGroup(id: string, label: string, failed: boolean | "cancelled"): void {
    if (this.closed) return;
    const group = this.active.get(id);
    this.active.delete(id);
    const duration = runtime(this.now() - (group?.started ?? this.now()));
    if (failed === "cancelled" || (failed && group?.task)) {
      this.message(
        `${failed === "cancelled" ? "Cancelled" : "Failed"} ${label}${group?.task ? `: ${group.task.label}` : ""} (${duration})`,
      );
    } else if (!this.interactive) this.message(`${failed ? "Failed" : "Completed"} ${label} (${duration})`);
    this.updateRefresh();
    this.draw();
  }
  stop(): void {
    this.stopping = true;
    this.draw();
  }
  message(text: string): void {
    if (this.paused) {
      if (this.deferred.length < 1000) this.deferred.push(safeOutput(text));
      return;
    }
    this.clear();
    this.output.write(`${safeOutput(text)}\n`);
    this.draw();
  }
  suspend(): void {
    this.clear();
    this.paused = true;
    this.updateRefresh();
  }
  resume(): void {
    this.paused = false;
    for (const line of this.deferred.splice(0)) this.output.write(`${line}\n`);
    this.updateRefresh();
    this.draw();
  }
  close(success: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.updateRefresh();
    this.clear();
    this.output.write(
      `${success ? "Passed" : "Stopped"} ${String(this.completed)}/${String(this.total)} checks${this.failures ? ` (${String(this.failures)} failed)` : ""} in ${runtime(this.now() - this.started)}.\n`,
    );
  }
  private updateRefresh(): void {
    const running = this.interactive && !this.closed && !this.paused && this.active.size > 0;
    if (running && !this.refresh) {
      this.refresh = setInterval(() => {
        this.draw();
      }, 250);
      this.refresh.unref();
    } else if (!running && this.refresh) {
      clearInterval(this.refresh);
      this.refresh = undefined;
    }
  }
  private clear(): void {
    if (this.height) {
      this.output.write(`\u001b[${String(this.height)}A\r\u001b[0J`);
      this.height = 0;
    }
  }
  private draw(): void {
    if (!this.interactive || this.paused || this.closed) return;
    this.clear();
    const columns = this.output.columns ?? 80;
    const rows = this.output.rows ?? 24;
    const width = Math.max(1, (columns > 0 ? columns : 80) - 1);
    const height = Math.max(0, (rows > 0 ? rows : 24) - 1);
    if (!height) return;
    const now = this.now();
    const tasks = [...this.active.values()];
    const slots = Math.max(0, height - 1 - (tasks.length >= height && height > 1 ? 1 : 0));
    const timed = (text: string, duration: number) => {
      const suffix = ` [${runtime(duration)}]`;
      return `${fit(text, Math.max(0, width - suffix.length))}${fit(suffix, width)}`;
    };
    const lines = [
      timed(
        `${String(this.completed)}/${String(this.total)} checks completed${this.stopping ? " — cancelling; waiting for cleanup" : ""}`,
        now - this.started,
      ),
      ...tasks
        .slice(0, slots)
        .map((group) =>
          timed(
            `${group.label}: ${group.task?.label ?? "preparing / finishing session"}`,
            now - (group.task?.started ?? group.started),
          ),
        ),
      ...(tasks.length > slots && height > 1 ? [fit(`  +${String(tasks.length - slots)} active groups`, width)] : []),
    ];
    this.output.write(`${lines.join("\n")}\n`);
    this.height = lines.length;
  }
}
