import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync, rmSync } from "node:fs";

/** Acquisition and generation finish first; each replacement then becomes visible atomically. */
export function replaceManagedFiles(files: readonly (readonly [string, string | Uint8Array])[]) {
  if (new Set(files.map(([path]) => path)).size !== files.length) throw new Error("Duplicate managed output path");
  const staged: [string, string][] = [];
  const failures: unknown[] = [];
  try {
    for (const [path, bytes] of files) {
      const temporary = `${path}.${randomUUID()}.partial`;
      staged.push([temporary, path]);
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 });
    }
    for (const [temporary, path] of staged) renameSync(temporary, path);
  } catch (error) {
    failures.push(error);
  }
  for (const [temporary] of staged) {
    try {
      rmSync(temporary, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Managed file replacement and cleanup failed");
}
