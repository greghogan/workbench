import { createWriteStream } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { retainDiagnosticStream } from "./diagnostics.js";

/** Own both channels through private creation, redaction, draining and final close. */
export class RetainedProcessLogs {
  private readonly stdoutSink;
  private readonly stderrSink;
  private readonly transfers: Promise<void>[] = [];
  private readonly seen = new Set<unknown>();
  private readonly opened: Promise<unknown>;
  private closed: Promise<void> | undefined;
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    private readonly onIssue: (failure: unknown) => void,
  ) {
    this.stdoutSink = createWriteStream(stdout, { flags: "wx", mode: 0o600 });
    this.stderrSink = createWriteStream(stderr, { flags: "wx", mode: 0o600 });
    for (const sink of [this.stdoutSink, this.stderrSink]) sink.on("error", this.issue);
    this.opened = Promise.all([once(this.stdoutSink, "open"), once(this.stderrSink, "open")]);
  }
  private readonly issue = (error: unknown) => {
    if (!this.seen.has(error)) {
      this.seen.add(error);
      this.onIssue(error);
    }
  };
  async open(): Promise<void> {
    await this.opened;
  }
  attach(source: Readable, channel: "stdout" | "stderr", secrets?: string[]): void {
    this.transfers.push(
      retainDiagnosticStream(source, channel === "stdout" ? this.stdoutSink : this.stderrSink, secrets).catch(
        this.issue,
      ),
    );
  }
  close(): Promise<void> {
    this.closed ??= (async () => {
      await this.opened.catch(this.issue);
      await Promise.all(this.transfers);
      for (const sink of [this.stdoutSink, this.stderrSink]) {
        try {
          sink.end();
          if (!sink.closed) await once(sink, "close");
        } catch (error) {
          this.issue(error);
        }
      }
    })();
    return this.closed;
  }
}
