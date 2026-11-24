import { stageReleaseArchive } from "../app/src/core/distribution/release-archive.js";
import { readDistributionManifest } from "../app/src/core/distribution/distribution-source-manifest.js";
import { packReleaseDirectory, unpackReleaseDirectory } from "../app/src/core/artifacts/release-directory.js";
import { hashFile } from "../app/src/core/runtime/file-reads.js";
import { processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../app/src/core/runtime/values.mjs";
import { isMainScript } from "./script-entry.mjs";

async function withReleaseDirectory<T>(
  archive: string,
  digest: string,
  action: (directory: string, scratch: string) => T | Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "workbench-release-archive-"));
  try {
    if (!archive.endsWith(".zip")) {
      const { directory } = await stageReleaseArchive(archive, digest, scratch);
      return await action(directory, scratch);
    }
    const local = join(scratch, "workbench.zip");
    copyFileSync(archive, local, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (hashFile(local) !== digest) throw new Error("Workbench ZIP checksum mismatch");
    const destination = join(scratch, "release");
    mkdirSync(destination, { mode: 0o700 });
    const directory = await unpackReleaseDirectory(local, destination, "zip", digest);
    readDistributionManifest(directory);
    return await action(directory, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Repackage the tested portable release without rebuilding its executable or embedding the TAR. */
export async function writeWorkbenchZip(archive: string, digest: string, output: string): Promise<void> {
  const cancellation = processCancellation();
  try {
    await withReleaseDirectory(archive, digest, async (directory, scratch) => {
      const staged = join(scratch, "artifact.zip");
      await packReleaseDirectory(directory, staged, "zip", cancellation.signal);
      copyFileSync(staged, output, constants.COPYFILE_EXCL);
    });
  } finally {
    cancellation.close();
  }
}

if (isMainScript(import.meta.url)) {
  const [archive] = process.argv.slice(2);
  if (!archive) throw new Error("Supply the Workbench archive to verify");
  await withReleaseDirectory(archive, hashFile(archive), (directory, scratch) => {
    const output = execFileSync(process.execPath, [join(directory, "bin/workbench.mjs"), "executable", "--json"], {
      cwd: scratch,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: scratch, WORKBENCH_DISTRIBUTION_ROOT: directory },
      encoding: "utf8",
    });
    const identity = record(JSON.parse(output), "The staged release did not return its executable identity");
    if (identity.directory !== realpathSync(directory))
      throw new Error("The staged release started another installation");
  });
}
