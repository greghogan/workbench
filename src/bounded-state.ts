import { existsSync } from "node:fs";
import { readBoundedFile } from "./file-reads.js";
import { writeAtomic } from "../scripts/file-publication.mjs";

/** Reads and writes pass through the same decoder and byte limit. */
export class BoundedState<T> {
  constructor(
    private readonly file: () => string,
    private readonly limit: number,
    private readonly decode: (value: unknown) => T,
    private readonly empty: () => T,
  ) {}
  read(): T {
    const path = this.file();
    if (!existsSync(path)) return this.empty();
    const body = readBoundedFile(path, this.limit, "state file").toString("utf8");
    return this.decode(JSON.parse(body) as unknown);
  }
  write(value: T): void {
    const body = JSON.stringify(this.decode(value), null, 2) + "\n";
    if (Buffer.byteLength(body) > this.limit) throw new Error(`${this.file()}: state exceeds the size limit`);
    writeAtomic(this.file(), body, 0o600);
  }
}
