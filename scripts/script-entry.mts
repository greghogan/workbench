import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node canonicalizes module URLs; command paths may still name a symlink or a macOS /var alias. */
export function isMainScript(url: string, invocation = process.argv[1]): boolean {
  if (invocation === undefined) return false;
  try {
    return realpathSync.native(invocation) === realpathSync.native(fileURLToPath(url));
  } catch (error) {
    // An importing `node -e` program may have an ordinary first argument instead of a script path.
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
