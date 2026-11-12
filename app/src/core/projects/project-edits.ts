import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { publishFile } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { StateConflict } from "../runtime/input-errors.js";

export interface ProjectEdit {
  path: string;
  contents: Buffer;
  previous?: Buffer;
  mode?: number;
}

/** Prepare every input and conflict before publishing; reject concurrent edits rather than replacing them. */
export class ProjectEdits {
  readonly files = new Map<string, ProjectEdit>();
  constructor(readonly root: string) {}
  read(path: string): string | undefined {
    return this.readBytes(path)?.toString("utf8");
  }
  private readBytes(path: string): Buffer | undefined {
    const pending = this.files.get(path);
    if (pending) return pending.contents;
    const absolute = ownedPath(this.root, path);
    if (!existsSync(absolute)) return undefined;
    return readBoundedFile(absolute, lstatSync(absolute).size, "project input");
  }
  write(path: string, contents: string | Uint8Array, mode?: number): void {
    const pending = this.files.get(path);
    this.plan(path, contents, pending ? pending.previous : this.readBytes(path), mode);
  }
  private plan(path: string, contents: string | Uint8Array, previous: Buffer | undefined, mode?: number): void {
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
    if (previous?.equals(bytes)) {
      this.files.delete(path);
      return;
    }
    const absolute = ownedPath(this.root, path);
    this.files.set(path, {
      path,
      contents: bytes,
      ...(previous === undefined ? {} : { previous }),
      ...(existsSync(absolute) ? { mode: lstatSync(absolute).mode & 0o777 } : mode === undefined ? {} : { mode }),
    });
  }
  replace(path: string, expected: Uint8Array, contents: string | Uint8Array): void {
    const pending = this.files.get(path),
      current = this.readBytes(path);
    if (!current?.equals(Buffer.from(expected)))
      throw new StateConflict(`${path} changed while preparing edits; inspect and retry`);
    this.plan(path, contents, pending ? pending.previous : current);
  }
  create(path: string, contents: string | Uint8Array, mode?: number): void {
    if (this.readBytes(path) !== undefined)
      throw new Error(`${path} already exists; use --adopt for an existing application`);
    this.write(path, contents, mode);
  }
  apply(): void {
    for (const file of this.files.values()) {
      const path = ownedPath(this.root, file.path);
      const current = existsSync(path) ? readFileSync(path) : undefined;
      if (current === undefined ? file.previous !== undefined : !file.previous?.equals(current))
        throw new StateConflict(`${file.path} changed during initialization; inspect and retry`);
    }
    const written: ProjectEdit[] = [];
    try {
      for (const file of this.files.values()) {
        const path = ownedPath(this.root, file.path);
        publishFile(path, file.contents, file.previous, file.mode);
        written.push(file);
      }
    } catch (error) {
      const cleanup: unknown[] = [];
      for (const file of written.reverse()) {
        try {
          const path = ownedPath(this.root, file.path);
          if (!existsSync(path) || !readFileSync(path).equals(file.contents)) continue;
          if (file.previous === undefined) rmSync(path);
          else publishFile(path, file.previous, file.contents, file.mode);
        } catch (failure) {
          cleanup.push(failure);
        }
      }
      if (cleanup.length)
        throw new AggregateError(
          cleanup,
          "Initialization failed; cleanup also failed and planned files need inspection",
          { cause: error },
        );
      throw error;
    }
  }
}
