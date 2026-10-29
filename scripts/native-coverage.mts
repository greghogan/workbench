import { realpathSync } from "node:fs";

/** LLVM matches coverage paths literally, including Windows short names and directory aliases. */
export function nativeCoverageSources(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => realpathSync.native(path)))];
}

/** LLVM falls back to all mapped files when every requested source is unmatched. Fail closed. */
export function assertNativeCoverageScope(reported: readonly string[], requested: readonly string[]): void {
  if (!reported.length || !requested.length) throw new Error("Native coverage requires mapped production sources");
  const sources = new Set(nativeCoverageSources(requested));
  for (const file of nativeCoverageSources(reported))
    if (!sources.has(file))
      throw new Error(`LLVM coverage reported a file outside the requested source scope: ${file}`);
}
