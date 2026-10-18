import { join } from "node:path";
import type { BuildOptions } from "esbuild";

export function bundleOptions(root: string, name: string, coverage = false): BuildOptions & { metafile: true } {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, `src/${name}.ts`)],
    bundle: true,
    // Resolve each package's own dependencies through pnpm's isolated store.
    preserveSymlinks: false,
    platform: "node",
    target: ["bootstrap", "launcher"].includes(name) ? "node18.20.8" : "node22",
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    minify: !coverage,
    keepNames: true,
    sourcemap: coverage ? "inline" : false,
    logLevel: "silent",
    metafile: true,
  };
}
