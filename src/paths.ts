import { InvalidInput } from "./input-errors.js";
import { lstatSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";

/** Project paths use portable slash-separated names on every host. */
export function relativePath(value: string, context: string, allowRoot = false): void {
  if (allowRoot && value === ".") return;
  if (
    !value ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /[\\:]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new InvalidInput(`${context}: unsafe relative path '${value}'`);
}

/** Reject symlinks at every existing component, including dangling links and record parents. */
export function ownedPath(root: string, value: string): string {
  relativePath(value, root, true);
  let current = root;
  const parts = value === "." ? [] : value.split("/");
  for (const [index, component] of parts.entries()) {
    current = join(current, component);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory()))
      throw new InvalidInput(`${current}: expected a real project path; symlinks are not supported`);
  }
  return current;
}
