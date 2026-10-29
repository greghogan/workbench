import type { Writable } from "node:stream";

/** A bounded observational sink: one omission notice after drain, with failures available to its owner. */
export class BoundedDiagnosticWriter {
  omitted = 0;
  failure: unknown;
  private pending = 0;
  private waiting = false;
  private readonly error = (error: unknown) => {
    this.failure ??= error;
  };
  private readonly drained = () => {
    this.waiting = false;
    this.flushOmissions();
  };
  constructor(
    private readonly output: Writable,
    private readonly notice: (omitted: number) => string,
    private readonly limit = 65536,
  ) {
    output.on("error", this.error);
  }
  write(text: string): boolean {
    if (this.failure) return false;
    if (this.output.writableLength > this.limit) {
      this.omitted++;
      this.pending++;
      if (!this.waiting) {
        this.waiting = true;
        this.output.once("drain", this.drained);
      }
      return false;
    }
    try {
      this.output.write(text);
      return true;
    } catch (error) {
      this.failure ??= error;
      return false;
    }
  }
  flushOmissions(final = false): void {
    if (!this.pending || this.failure) return;
    const omitted = this.pending;
    if (final) {
      try {
        this.output.write(this.notice(omitted));
        this.pending = 0;
      } catch (error) {
        this.failure ??= error;
      }
    } else if (this.write(this.notice(omitted))) this.pending = 0;
  }
  dispose(): void {
    this.output.removeListener("error", this.error);
    this.output.removeListener("drain", this.drained);
  }
}
