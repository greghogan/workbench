import { join } from "node:path";

export function bundleOptions(root, name, coverage = false) {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, `src/${name}.ts`)],
    bundle: true,
    // Resolve each package's own dependencies through pnpm's isolated store.
    preserveSymlinks: false,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    minify: !coverage,
    keepNames: true,
    sourcemap: coverage ? "inline" : false,
    logLevel: "silent",
    metafile: true,
  };
}
