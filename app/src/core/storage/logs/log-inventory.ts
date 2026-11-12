import { settleCleanup } from "../../diagnostics/diagnostic-errors.mjs";
import { createReadStream, mkdirSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOwnedScratch, type OwnedScratch } from "../../runtime/owned-scratch.mjs";
import { userDirectory } from "../storage.js";
import type { RetentionRun } from "./log-retention.js";

export const compareRetentionRuns = (a: RetentionRun, b: RetentionRun): number =>
  a.completed - b.completed || a.directory.localeCompare(b.directory);

/** External merge sorting bounds resident inventory and open files while scanning every owned unit. */
export class LogInventory {
  private scratch: OwnedScratch | undefined;
  private readonly levels: string[][] = [];
  private rows: RetentionRun[] = [];
  private bytes = 0;
  private next = 0;
  totalBytes = 0;
  newest: RetentionRun | undefined;
  constructor(private readonly chunkBytes = 512 * 1024) {}
  private path(): string {
    if (!this.scratch) {
      const parent = join(userDirectory("cache"), "log-inventory");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      this.scratch = createOwnedScratch(parent, "inventory");
    }
    return join(this.scratch.directory, `${String(this.next++)}.jsonl`);
  }
  async add(row: RetentionRun): Promise<void> {
    this.rows.push(row);
    this.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    this.totalBytes += row.bytes;
    if (row.eligible && (!this.newest || compareRetentionRuns(this.newest, row) < 0)) this.newest = row;
    if (this.bytes >= this.chunkBytes) await this.flush();
  }
  private async flush(): Promise<void> {
    if (!this.rows.length) return;
    this.rows.sort(compareRetentionRuns);
    const path = this.path(),
      file = await open(path, "wx", 0o600);
    let failure: unknown;
    try {
      await file.writeFile(this.rows.map((row) => JSON.stringify(row) + "\n").join(""));
    } catch (error) {
      failure = error;
    }
    await settleCleanup([() => file.close()], failure);
    this.rows = [];
    this.bytes = 0;
    await this.addPart(path, 0);
  }
  private async addPart(path: string, level: number): Promise<void> {
    const parts = this.levels[level] ?? [];
    parts.push(path);
    this.levels[level] = parts;
    if (parts.length < 16) return;
    this.levels[level] = [];
    await this.addPart(await this.merge(parts), level + 1);
  }
  private async *read(path: string): AsyncGenerator<RetentionRun> {
    const source = createReadStream(path, { encoding: "utf8" });
    let pending = "";
    for await (const chunk of source) {
      pending += chunk as string;
      let start = 0;
      for (;;) {
        const end = pending.indexOf("\n", start);
        if (end < 0) break;
        yield JSON.parse(pending.slice(start, end)) as RetentionRun;
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending) throw new Error("Incomplete log retention inventory; preserving logs");
  }
  private async merge(paths: string[]): Promise<string> {
    const destination = this.path(),
      file = await open(destination, "wx", 0o600);
    const sources = paths.map((path) => this.read(path));
    let failure: unknown;
    try {
      const heads = await Promise.all(sources.map((source) => source.next()));
      let output = "";
      for (;;) {
        let smallest: { index: number; row: RetentionRun } | undefined;
        for (const [index, head] of heads.entries())
          if (!head.done && (!smallest || compareRetentionRuns(head.value, smallest.row) < 0))
            smallest = { index, row: head.value };
        if (!smallest) break;
        output += JSON.stringify(smallest.row) + "\n";
        if (output.length >= 32768) {
          await file.writeFile(output);
          output = "";
        }
        const source = sources[smallest.index];
        if (!source) throw new Error("Invalid log inventory merge");
        heads[smallest.index] = await source.next();
      }
      if (output) await file.writeFile(output);
    } catch (error) {
      failure = error;
    }
    await settleCleanup([...sources.map((source) => () => source.return(undefined)), () => file.close()], failure);
    for (const path of paths) await rm(path);
    return destination;
  }
  async *sorted(): AsyncGenerator<RetentionRun> {
    if (!this.scratch) {
      this.rows.sort(compareRetentionRuns);
      yield* this.rows;
      return;
    }
    await this.flush();
    let parts = this.levels.flat();
    while (parts.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < parts.length; index += 16)
        next.push(await this.merge(parts.slice(index, index + 16)));
      parts = next;
    }
    if (parts[0]) yield* this.read(parts[0]);
  }
  close(): void {
    this.scratch?.release();
    this.scratch = undefined;
    this.rows = [];
    this.levels.length = 0;
    this.bytes = 0;
  }
}
