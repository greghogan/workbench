import { existsSync, lstatSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnostic } from "./diagnostics.mjs";
import { LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostic-contract.mjs";
export const cacheSizeMarker = ".workbench-cache-size.json";
export const cacheGenerationMarker = ".workbench-cache-generation";
/** A command owns invalidation through completion, including asynchronous rejection and cancellation. */
export function withCacheSizeChanges<T>(directories: (string | undefined)[], action: () => T): T {
  const invalidate = () => {
    for (const directory of directories) if (directory) invalidateCacheSize(directory, true);
  };
  invalidate();
  try {
    const value = action();
    if (value instanceof Promise) return value.finally(invalidate) as T;
    invalidate();
    return value;
  } catch (error) {
    invalidate();
    throw error;
  }
}
/** Standalone lock users invalidate estimates without loading project configuration or the application. */
export function invalidateCacheSize(directory: string, initialize = false): void {
  try {
    if (!existsSync(directory)) return;
    if (
      !initialize &&
      !existsSync(join(directory, cacheSizeMarker)) &&
      !existsSync(join(directory, cacheGenerationMarker))
    )
      return;
    const stat = lstatSync(directory);
    // The lock helper also protects individual state files; those have no directory accounting.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const temporary = join(directory, `.${cacheGenerationMarker}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, randomUUID() + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, join(directory, cacheGenerationMarker));
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    try {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.CacheLock,
        DiagnosticOutcome.Unavailable,
        { directory, operation: "cache size invalidation" },
        error,
      );
    } catch {
      /* Optional size accounting cannot change the writer's outcome. */
      return;
    }
  }
}
