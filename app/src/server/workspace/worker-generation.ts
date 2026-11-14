import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distributionRoot } from "../../core/projects/project-context.js";
import { copyFileToDescriptor, readBoundedFile, readFilePrefix } from "../../core/runtime/file-reads.js";
import { writeNew } from "../../core/runtime/file-publication.mjs";
import {
  decodeBundle,
  bundleFormats,
  lazyBundles,
  type BundleCompression,
} from "../../core/distribution/bundle-artifacts.mjs";

/** A listener's workers use one immutable executable generation until all admitted work has drained. */
export class WorkerGeneration {
  readonly directory: string;
  readonly path: string;
  constructor(root: string) {
    const distribution = distributionRoot(root);
    const capture = (name: string) => {
      const file = join(distribution, `bundle/${name}.cjs`);
      const loader = readFilePrefix(file, 512);
      const compression =
        loader.length < 512
          ? (/^require\("\.\.\/bin\/bundle-runtime\.cjs"\)\(module, __filename, "(brotli|zlib|zstd)", require\);\s*$/.exec(
              loader.toString(),
            )?.[1] as BundleCompression | undefined)
          : undefined;
      const destination = join(this.directory, `${name}.cjs`);
      if (compression)
        writeNew(
          destination,
          decodeBundle(
            readBoundedFile(`${file}.${bundleFormats[compression]}`, 16 * 1024 * 1024, "worker payload"),
            compression,
          ),
          0o600,
        );
      else
        writeNew(
          destination,
          (descriptor) => {
            copyFileToDescriptor(file, descriptor);
          },
          0o600,
        );
    };
    this.directory = mkdtempSync(join(tmpdir(), "workbench-workers-"));
    this.path = join(this.directory, "main.cjs");
    try {
      for (const name of ["main", ...lazyBundles]) capture(name);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
