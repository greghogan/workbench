import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { BuildOptions } from "esbuild";
import { authoredTooling } from "./authored-tooling.mts";
import { minimumBootstrapNode, minimumCliNode } from "./node-runtimes.mjs";
import { lazyBundles } from "./bundle-artifacts.mjs";
export { lazyBundles } from "./bundle-artifacts.mjs";

export const bundleRuntime = (name: string): string =>
  ["bootstrap", "launcher"].includes(name) ? minimumBootstrapNode : minimumCliNode;

export function bundleOptions(root: string, name: string, coverage = false): BuildOptions & { metafile: true } {
  root = realpathSync.native(root);
  return {
    absWorkingDir: root,
    entryPoints: [join(root, `src/${name}.ts`)],
    bundle: true,
    plugins: [
      {
        name: "lazy-runtime-bundles",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(?:formatter|attestation-verification)\.js$/ }, (request) => {
            if (request.kind !== "dynamic-import") return;
            const entry = lazyBundles.find(
              (name) => resolve(request.resolveDir, request.path) === join(root, "src", `${name}.js`),
            );
            return entry ? { path: entry, namespace: "runtime-bundle" } : undefined;
          });
          // The compressed loader supplies CommonJS require, without a VM dynamic-import callback.
          builder.onLoad({ filter: /.*/, namespace: "runtime-bundle" }, (request) => ({
            contents: `module.exports = require("./${request.path}.cjs");`,
            loader: "js",
          }));
          builder.onResolve({ filter: /\.cjs$/, namespace: "runtime-bundle" }, (request) => ({
            path: request.path,
            external: true,
          }));
          // TOML editing is a pure library; read-only bootstrap paths need no syntax-tree parser initialization.
          builder.onResolve({ filter: /(?:^|\/)toml-edit\.js$/ }, (request) =>
            resolve(request.resolveDir, request.path) === join(root, "src/toml-edit.js")
              ? { path: join(root, "src/toml-edit.ts"), sideEffects: false }
              : undefined,
          );
        },
      },
      authoredTooling(),
    ],
    // Resolve each package's own dependencies through pnpm's isolated store.
    preserveSymlinks: false,
    platform: "node",
    target: `node${bundleRuntime(name)}`,
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    minify: !coverage,
    keepNames: true,
    sourcemap: coverage ? "inline" : false,
    logLevel: "silent",
    metafile: true,
  };
}
