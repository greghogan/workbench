import { lstatSync, statSync } from "node:fs";
export function inputStamp(path: string): string {
  try {
    const stat = lstatSync(path);
    const target = stat.isSymbolicLink() ? statSync(path, { throwIfNoEntry: false }) : undefined;
    return JSON.stringify([
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      ...(target ? [target.ino, target.size, target.mtimeMs, target.ctimeMs] : []),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
      return "missing";
    throw error;
  }
}
