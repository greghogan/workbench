import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distributionRoot } from "../project-context.js";
import { readBoundedFile } from "../file-reads.js";
import { decodeBundle, bundleFormats, lazyBundles, type BundleCompression } from "../../scripts/bundle-artifacts.mjs";

/** A listener's workers use one immutable executable generation until all admitted work has drained. */
export class WorkerGeneration {
  readonly directory: string;
  readonly path: string;
  constructor(root: string) {
    const distribution = distributionRoot(root);
    const capture = (name: string) => {
      const file = join(distribution, `bundle/${name}.cjs`);
      const loader = readBoundedFile(file, 16 * 1024 * 1024, "worker bundle");
      const compression =
        /^require\("\.\.\/bin\/bundle-runtime\.cjs"\)\(module, __filename, "(brotli|zlib|zstd)", require\);\s*$/.exec(
          loader.toString(),
        )?.[1] as BundleCompression | undefined;
      return compression
        ? decodeBundle(
            readBoundedFile(`${file}.${bundleFormats[compression]}`, 16 * 1024 * 1024, "worker payload"),
            compression,
          )
        : loader;
    };
    this.directory = mkdtempSync(join(tmpdir(), "workbench-workers-"));
    this.path = join(this.directory, "main.cjs");
    try {
      for (const name of ["main", ...lazyBundles])
        writeFileSync(join(this.directory, `${name}.cjs`), capture(name), { mode: 0o600, flag: "wx" });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
