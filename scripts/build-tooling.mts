import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { format, resolveConfig } from "prettier";
import type { CoverageSourceMap } from "./node-coverage-reports.mjs";

/** Keep copied reference helpers and installed packages executable with ordinary Node. */
export async function buildTooling(root: string, check = false): Promise<void> {
  const emit = async (source: string, standalone = false): Promise<void> => {
    const reference = relative(root, source).split("\\").join("/").startsWith("examples/");
    const commonjs = source.endsWith(".cts");
    const destination = source.slice(0, -4) + (commonjs ? ".cjs" : ".mjs");
    const contents = readFileSync(source, "utf8");
    const banner = `// Generated from ${basename(source)}; edit the TypeScript source.`;
    let code: string;
    if (standalone) {
      const result = await build({
        entryPoints: [source],
        outfile: destination,
        bundle: true,
        packages: "external",
        platform: "node",
        target: "es2022",
        format: "esm",
        sourcemap: "inline",
        sourcesContent: true,
        banner: { js: banner },
        write: false,
      });
      const output = result.outputFiles[0];
      if (!output) throw new Error(`${source}: fixture compilation produced no output`);
      code = output.text;
    } else {
      const result = await transform(contents, {
        loader: "ts",
        target: "es2022",
        format: commonjs ? "cjs" : "esm",
        sourcefile: basename(source),
        // Formatting reference JavaScript would invalidate the original emission map.
        sourcemap: reference ? false : "inline",
        sourcesContent: true,
        banner,
      });
      code = result.code;
    }
    if (reference) code = await format(code, { ...(await resolveConfig(destination)), filepath: destination });
    // A portable generated-file identity distinguishes identical helpers even after copying or renaming them.
    code = code.replace(
      /(sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,)([^\s]+)/,
      (_, prefix: string, encoded: string) => {
        const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CoverageSourceMap;
        map.file = relative(root, destination).split("\\").join("/");
        return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
      },
    );
    if (check) {
      if (!existsSync(destination) || readFileSync(destination, "utf8") !== code)
        throw new Error(`${relative(root, destination)} is stale; run pnpm run tooling:build`);
      if (process.platform !== "win32" && (statSync(source).mode & 0o111) !== (statSync(destination).mode & 0o111))
        throw new Error(`${relative(root, destination)} has stale executable permissions; run pnpm run tooling:build`);
    } else {
      writeFileSync(destination, code);
      chmodSync(destination, statSync(source).mode & 0o777);
    }
  };
  const skipped = new Set([
    "node_modules",
    "vendor",
    "target",
    "build",
    "dist",
    "coverage",
    ".venv",
    ".direnv",
    ".git",
  ]);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(directory, entry.name);
      if (entry.isDirectory() && !skipped.has(entry.name)) await visit(source);
      else if (entry.isFile() && /\.[mc]ts$/.test(entry.name) && !/\.d\.[mc]ts$/.test(entry.name)) await emit(source);
    }
  };
  for (const directory of ["scripts", "examples", "bin"]) await visit(join(root, directory));
  for (const name of ["vitest.config.mts", "eslint.config.mts"])
    if (existsSync(join(root, name))) await emit(join(root, name));
  for (const name of ["ci-docker", "ci-workbench"]) await emit(join(root, `tests/fixtures/${name}.mts`), true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildTooling(resolve(import.meta.dirname, ".."), process.argv.includes("--check"));
