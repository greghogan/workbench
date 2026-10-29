import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "esbuild";
import { generatedSource } from "../src/generated-file.ts";

/** Bundles read authored helpers, so an old emitted dependency cannot contaminate a new build. */
export function authoredTooling(): Plugin {
  return {
    name: "authored-tooling",
    setup(builder) {
      builder.onLoad({ filter: /\.[mc]?js$/, namespace: "file" }, (args) => {
        if (!args.path.split(/[\\/]/).includes("node_modules")) return;
        const original = readFileSync(args.path, "utf8");
        // Map distributed JavaScript, rather than external upstream maps whose unpublished sources depend on store layout.
        const contents = original.replace(/^[\t ]*\/\/[#@]\s*sourceMappingURL=(?!data:)[^\r\n]*$/gm, "");
        return contents === original ? undefined : { contents, loader: "js", resolveDir: dirname(args.path) };
      });
      builder.onResolve({ filter: /\.[mc]js$/ }, (args) => {
        if (!args.path.startsWith(".")) return;
        const source = generatedSource(resolve(args.resolveDir, args.path));
        return source && existsSync(source) ? { path: source } : undefined;
      });
    },
  };
}
