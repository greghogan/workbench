import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { generatedSource } from "../src/generated-file.ts";

/** Bundles read authored helpers, so an old emitted dependency cannot contaminate a new build. */
export function authoredTooling(): Plugin {
  return {
    name: "authored-tooling",
    setup(builder) {
      builder.onResolve({ filter: /\.[mc]js$/ }, (args) => {
        if (!args.path.startsWith(".")) return;
        const source = generatedSource(resolve(args.resolveDir, args.path));
        return source && existsSync(source) ? { path: source } : undefined;
      });
    },
  };
}
