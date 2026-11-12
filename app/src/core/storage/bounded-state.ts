import { InvalidInput, MissingResource, StateConflict } from "../runtime/input-errors.js";
import { existsSync } from "node:fs";
import { readBoundedFile, FileChanged } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";

/** Reads and writes pass through the same decoder and byte limit. */
export class BoundedState<T> {
  constructor(
    private readonly file: () => string,
    private readonly limit: number,
    private readonly decode: (value: unknown) => T,
    private readonly empty: () => T,
  ) {}
  private decodeAt(value: unknown): T {
    try {
      return this.decode(value);
    } catch (cause) {
      const message = `${this.file()}: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (cause instanceof InvalidInput) throw new InvalidInput(message, { cause });
      if (cause instanceof MissingResource) throw new MissingResource(message, { cause });
      if (cause instanceof StateConflict) throw new StateConflict(message, { cause });
      throw new Error(message, { cause });
    }
  }
  read(): T {
    const path = this.file();
    if (!existsSync(path)) return this.empty();
    for (let attempt = 0; ; attempt++) {
      try {
        const body = readBoundedFile(path, this.limit, "state file").toString("utf8");
        let input: unknown;
        try {
          input = JSON.parse(body) as unknown;
        } catch (cause) {
          throw new Error(`${path}: invalid JSON`, { cause });
        }
        return this.decodeAt(input);
      } catch (error) {
        // Atomic replacement may unlink the open inode and change ctime while another command reads it.
        if (!(error instanceof FileChanged) || attempt >= 2) throw error;
      }
    }
  }
  write(value: T): void {
    const body = JSON.stringify(this.decodeAt(value), null, 2) + "\n";
    if (Buffer.byteLength(body) > this.limit) throw new Error(`${this.file()}: state exceeds the size limit`);
    writeAtomic(this.file(), body, 0o600);
  }
}
