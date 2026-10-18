import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Approximate file bytes without following links; disappearing build products contribute zero. */
export function cacheBytes(path: string): number {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory()
      ? readdirSync(path).reduce((total, name) => total + cacheBytes(join(path, name)), 0)
      : metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
