import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { distributionRoot } from "./project-context.js";
import { distributionFiles, distributionPathIncluded, runtimeFiles } from "./distribution-layout.js";
import { readBoundedFile } from "./file-reads.js";
import { withCacheLockSync, releaseAfterFailure } from "./cache-lock.js";


import { readDistributionSource } from "./distribution-identity.js";
import { distributionManifestFile, readDistributionManifest } from "./distribution-source-manifest.js";
import { gitBytes } from "./git-snapshot.js";

function copyBundle(source: string, destination: string): void {
  cpSync(join(source, "bundle"), join(destination, "bundle"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (path) => distributionPathIncluded(relative(source, path)),
  });
}

function matchesPackagedCheckout(project: string, distribution: string): boolean {
  if (
    !existsSync(join(project, ".git")) ||
    !existsSync(join(project, "package.json")) ||
    !existsSync(join(distribution, distributionManifestFile)) ||
    !existsSync(join(distribution, "bundle/launcher.cjs"))
  )
    return false;
  const source = readDistributionSource(distribution);
  if (
    !source ||
    readBoundedFile(join(project, "package.json"), 1024 * 1024, "checkout package manifest").toString("utf8") !==
      readDistributionManifest(distribution).contents
  )
    return false;
  const [revision, ...status] = gitBytes(project, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"])
    .toString("utf8")
    .trimEnd()
    .split("\n");
  return revision === `# branch.oid ${source.revision}` && status.every((entry) => entry.startsWith("# "));
}

/** A rehearsal owns an independently writable copy; copy-on-write avoids duplicating immutable payload blocks. */
export function materializeDistribution(project: string, destination: string, fallback: string): string {
  const source = fallback || distributionRoot(project);
  const inside = relative(project, source);
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)) {
    const runtime = join(destination, inside);
    if (existsSync(join(source, "bundle"))) copyBundle(source, runtime);
    return runtime;
  }
  if (matchesPackagedCheckout(project, source)) {
    // Native image builds exclude .git and enter through the checkout's launcher.
    copyBundle(source, destination);
    return destination;
  }
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
