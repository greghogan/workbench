import { existsSync } from "node:fs";
import { readBoundedFile, FileChanged } from "./file-reads.js";
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
    for (let attempt = 0; ; attempt++) {
      try {
        const body = readBoundedFile(path, this.limit, "state file").toString("utf8");
        return this.decode(JSON.parse(body) as unknown);
      } catch (error) {
        // Atomic replacement may unlink the open inode and change ctime while another command reads it.
        if (!(error instanceof FileChanged) || attempt >= 2) throw error;
      }
    }
  }
  write(value: T): void {
    const body = JSON.stringify(this.decode(value), null, 2) + "\n";
    if (Buffer.byteLength(body) > this.limit) throw new Error(`${this.file()}: state exceeds the size limit`);
    writeAtomic(this.file(), body, 0o600);
  }
}
