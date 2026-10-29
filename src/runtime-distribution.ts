import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { distributionRoot } from "./project-context.js";
import { distributionFiles, distributionPathIncluded, runtimeFiles } from "./distribution-layout.js";
import { readBoundedFile } from "./file-reads.js";
import { withCacheLockSync, releaseAfterFailure } from "./cache-lock.js";

/** A rehearsal owns an independently writable copy; copy-on-write avoids duplicating immutable payload blocks. */
export function materializeDistribution(project: string, destination: string, fallback: string): string {
  const source = fallback || distributionRoot(project);
  const inside = relative(project, source);
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)) return join(destination, inside);
  const output = join(destination, ".git/workbench/runtime");
  return withCacheLockSync(output, () => {
    if (existsSync(output)) return output;
    const manifest: unknown = existsSync(join(source, "package.json"))
      ? JSON.parse(readBoundedFile(join(source, "package.json"), 1024 * 1024, "distribution manifest").toString("utf8"))
      : undefined;
    const entries =
      manifest && typeof manifest === "object" && "files" in manifest
        ? distributionFiles(manifest.files)
        : runtimeFiles;
    mkdirSync(dirname(output), { recursive: true });
    const temporary = mkdtempSync(join(dirname(output), ".runtime-"));
    try {
      for (const name of new Set([...entries, "package.json"])) {
        if (!existsSync(join(source, name))) continue;
        cpSync(join(source, name), join(temporary, name), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
          filter: (path) => distributionPathIncluded(relative(source, path)),
        });
      }
      renameSync(temporary, output);
    } catch (failure) {
      releaseAfterFailure(
        () => {
          rmSync(temporary, { recursive: true, force: true });
        },
        failure,
        "Distribution materialization and cleanup failed",
      );
    }
    rmSync(temporary, { recursive: true, force: true });
    return output;
  });
}
