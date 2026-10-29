import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Keep the source newline contract independent of the selected formatter's defaults. */
export function canonicalJavaSources(directory: string, write = false): void {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".java")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = readFileSync(path, "utf8");
    if (!source.includes("\r")) continue;
    if (!write)
      throw new Error(`${relative(directory, path)}: Java sources require LF line endings; run the format-write role`);
    writeFileSync(path, source.replace(/\r\n?/g, "\n"));
  }
}
