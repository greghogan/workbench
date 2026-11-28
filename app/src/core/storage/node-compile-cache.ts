import { enableCompileCache, getCompileCacheDir } from "node:module";
import { readdir, lstat, unlink, rmdir } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import { ownedPath } from "../runtime/paths.js";
import { userDirectory } from "./storage.js";

export const runtimeCompileCacheDirectory = (): string => ownedPath(userDirectory("cache"), "node-compile");

/** Bytecode files are published and removed inside version directories. */
export function runtimeCompileRetentionState() {
  const root = runtimeCompileCacheDirectory();
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const { dev, ino, mtimeMs, ctimeMs } = lstatSync(ownedPath(root, name));
      return [name, dev, ino, mtimeMs, ctimeMs];
    });
}

/** Optional bytecode caching must never prevent execution or reduce coverage precision. */
export function enableRuntimeCompileCache(): void {
  if (
    process.env.NODE_DISABLE_COMPILE_CACHE ||
    process.env.NODE_V8_COVERAGE ||
    process.env.WORKBENCH_SUBPROCESS_COVERAGE ||
    process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1"
  )
    return;
  try {
    const requested = process.env.NODE_COMPILE_CACHE;
    if (!getCompileCacheDir()) enableCompileCache(requested?.length ? requested : runtimeCompileCacheDirectory());
  } catch {
    // A missing or unwritable cache changes startup cost, not command behavior.
  }
}

/** Node's disposable bytecode can be regenerated, including after concurrent eviction. */
export async function pruneRuntimeCompileCache(maxAgeDays: number, now = Date.now()): Promise<number> {
  if (maxAgeDays <= 0) return Infinity;
  let nextScan = Infinity;
  let scanning = false;
  try {
    const root = runtimeCompileCacheDirectory();
    const versions = await readdir(root, { withFileTypes: true });
    scanning = true;
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const directory = ownedPath(root, version.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = ownedPath(directory, entry.name);
        const before = await lstat(file);
        if (!before.isFile()) continue;
        const deadline = before.mtimeMs + maxAgeDays * 86_400_000;
        if (deadline > now) nextScan = Math.min(nextScan, deadline);
        else {
          const current = await lstat(file);
          if (before.ino === current.ino && before.mtimeMs === current.mtimeMs) await unlink(file);
          else nextScan = now;
        }
      }
      try {
        await rmdir(directory);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
        ))
          throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (scanning) return now;
  }
  return nextScan;
}
