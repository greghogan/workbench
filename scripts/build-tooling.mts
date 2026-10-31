import {
  maintainerSources,
  toolingAdditionalSources,
  toolingArtifact,
  toolingIgnores,
  type ToolingArtifact,
} from "./tooling-artifacts.mts";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { format, resolveConfig } from "prettier";
import type { CoverageSourceMap } from "./node-coverage-reports.mjs";
import { parse } from "smol-toml";
import { parseArgs } from "node:util";
import { generatedBanner } from "../src/generated-file.ts";
import { writeAtomic } from "./file-publication.mjs";
import { authoredTooling } from "./authored-tooling.mts";

export type ToolingOperation = "build" | "verify" | "prepare-development";

export function parseToolingOperation(args: string[]): ToolingOperation | "help" {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      check: { type: "boolean" },
      "maintainers-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.check && values["maintainers-only"]) throw new Error("--check and --maintainers-only cannot be combined");
  return values.help ? "help" : values.check ? "verify" : values["maintainers-only"] ? "prepare-development" : "build";
}

export function collectToolingArtifacts(root: string, scope: "all" | "development" = "all"): ToolingArtifact[] {
  const sources = new Set<string>();
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
  const visit = (directory: string) => {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !skipped.has(entry.name)) visit(path);
      else if (entry.isFile() && /\.[mc]ts$/.test(entry.name) && !/\.d\.[mc]ts$/.test(entry.name)) sources.add(path);
    }
  };
  if (scope === "development") {
    for (const path of maintainerSources) if (existsSync(join(root, path))) sources.add(path);
    visit("scripts/maintenance");
  } else {
    for (const directory of ["scripts", "examples", "bin"]) visit(directory);
    for (const path of toolingAdditionalSources) if (existsSync(join(root, path))) sources.add(path);
  }
  return [...sources].sort().map(toolingArtifact);
}

/** Keep copied reference helpers and installed packages executable with ordinary Node. */
export async function buildTooling({
  root: suppliedRoot,
  operation,
}: {
  root: string;
  operation: ToolingOperation;
}): Promise<void> {
  const root = realpathSync(suppliedRoot);
  const check = operation === "verify";
  const maintainersOnly = operation === "prepare-development";
  const ignorePath = join(root, ".gitignore");
  if (existsSync(ignorePath)) {
    const original = readFileSync(ignorePath, "utf8"),
      expected = toolingIgnores(original);
    if (operation !== "build" && original !== expected)
      throw new Error("Tooling ignore policy is stale; run pnpm run tooling:build");
    if (operation === "build" && original !== expected)
      writeAtomic(ignorePath, expected, statSync(ignorePath).mode & 0o777);
  }
  const nativeLanguages = maintainersOnly
    ? []
    : ["c", "cpp"].filter((language) => existsSync(join(root, "examples/languages", language)));
  if (nativeLanguages.length) {
    for (const [source, target] of [
      ["scripts/cmake/WorkbenchCompiler.cmake", "cmake/WorkbenchCompiler.cmake"],
      ["scripts/native-cpu.h", "include/wb_cpu.h"],
      ["scripts/native-cpu-test.c", "tests/cpu_test.c"],
    ]) {
      if (!source || !target) throw new Error("Invalid native reference asset");
      const contents = readFileSync(join(root, source));
      const mode = statSync(join(root, source)).mode & 0o777;
      for (const language of nativeLanguages) {
        const path = join(root, "examples/languages", language, target);
        if (check) {
          if (!existsSync(path) || !readFileSync(path).equals(contents))
            throw new Error(`${path} is stale; run pnpm run tooling:build`);
        } else {
          writeAtomic(path, contents, mode);
        }
      }
    }
  }
  const languages = join(root, "languages");
  for (const language of !maintainersOnly && existsSync(languages)
    ? readdirSync(languages, { withFileTypes: true })
    : []) {
    if (!language.isDirectory()) continue;
    const directory = join(root, "languages", language.name);
    const metadata = parse(readFileSync(join(directory, "config.toml"), "utf8")) as {
      reference: string;
      starter_assets?: { path: string; source: string }[];
    };
    for (const asset of metadata.starter_assets ?? []) {
      const target = join(directory, asset.source);
      const contents = readFileSync(join(root, metadata.reference, asset.path));
      if (check) {
        if (!existsSync(target) || !readFileSync(target).equals(contents))
          throw new Error(`${relative(root, target)} is stale; run pnpm run tooling:build`);
      } else writeAtomic(target, contents);
    }
  }
  if (!maintainersOnly && existsSync(join(root, "src/web/client.ts"))) {
    const browser = await build({
      entryPoints: [join(root, "src/web/client.ts")],
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "iife",
      minify: true,
      metafile: true,
      write: false,
    });
    if (
      Object.keys(browser.metafile.inputs).some((path) =>
        /node_modules\/preact(?:\/|-render-to-string\/)/.test(path.replaceAll("\\", "/")),
      )
    )
      throw new Error("Server rendering dependencies must not enter the browser bundle");
    const browserCode = browser.outputFiles[0]?.text;
    if (!browserCode) throw new Error("browser compilation produced no output");
    const css = await build({
      entryPoints: [join(root, "src/web/style.css")],
      bundle: true,
      minify: true,
      target: "es2022",
      write: false,
    });
    const stylesheet = css.outputFiles[0]?.text;
    if (!stylesheet) throw new Error("Stylesheet compilation produced no output");
    const assetPath = join(root, "src/web/assets.ts");
    const asset = await format(
      `// Generated from client.ts and style.css by build-tooling; edit those sources.\nexport const browserScript = ${JSON.stringify(browserCode)};\nexport const stylesheet = ${JSON.stringify(stylesheet)};\n`,
      { parser: "typescript", ...(await resolveConfig(assetPath)) },
    );
    if (check) {
      if (!existsSync(assetPath) || readFileSync(assetPath, "utf8") !== asset)
        throw new Error("browser assets are stale; run pnpm run tooling:build");
    } else writeAtomic(assetPath, asset);
  }
  const emit = async (policy: ToolingArtifact): Promise<void> => {
    if (policy.emission === "none" || (check && !policy.tracked) || (maintainersOnly && policy.tracked)) return;
    const source = join(root, policy.source);
    const reference = relative(root, source).split("\\").join("/").startsWith("examples/");
    const commonjs = source.endsWith(".cts");
    const destination = join(root, policy.output);
    const banner = generatedBanner(policy.source);
    let code: string;
    if (policy.emission === "bundle") {
      const result = await build({
        absWorkingDir: root,
        entryPoints: [source],
        outfile: destination,
        bundle: true,
        packages: policy.category === "runtime" ? "bundle" : "external",
        platform: "node",
        target: "es2022",
        format: "esm",
        // Physical dependency-store labels must not enter portable generated files.
        minify: policy.category === "runtime",
        sourcemap: "inline",
        sourcesContent: true,
        banner: {
          js: [
            banner,
            ...(policy.category === "runtime"
              ? [
                  'import { createRequire as __workbenchCreateRequire } from "node:module";',
                  "const require = __workbenchCreateRequire(import.meta.url);",
                ]
              : []),
          ].join("\n"),
        },
        write: false,
        plugins: [authoredTooling()],
      });
      const output = result.outputFiles[0];
      if (!output) throw new Error(`${source}: fixture compilation produced no output`);
      code = output.text;
    } else {
      const result = await transform(readFileSync(source, "utf8"), {
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
    if (/[\t ]+$/m.test(code))
      throw new Error(
        `${relative(root, destination)}: generated JavaScript contains trailing whitespace; construct significant padding separately from newline escapes`,
      );
    // A portable generated-file identity distinguishes identical helpers even after copying or renaming them.
    code = code.replace(
      /(sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,)([^\s]+)/,
      (_, prefix: string, encoded: string) => {
        const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CoverageSourceMap;
        map.file = relative(root, destination).split("\\").join("/");
        map.sources = map.sources.map((source) => {
          const path = (source ?? "").replaceAll("\\", "/");
          const dependency = path.lastIndexOf("/node_modules/");
          return dependency < 0 ? path : `../${path.slice(dependency + 1)}`;
        });
        return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
      },
    );
    if (check) {
      if (!existsSync(destination) || readFileSync(destination, "utf8") !== code)
        throw new Error(`${relative(root, destination)} is stale; run pnpm run tooling:build`);
      if (process.platform !== "win32" && (statSync(source).mode & 0o111) !== (statSync(destination).mode & 0o111))
        throw new Error(`${relative(root, destination)} has stale executable permissions; run pnpm run tooling:build`);
    } else {
      writeAtomic(destination, code, statSync(source).mode & 0o777);
    }
  };
  const artifacts = collectToolingArtifacts(root, maintainersOnly ? "development" : "all");
  for (const artifact of artifacts.filter((item) => item.emission !== "bundle")) await emit(artifact);
  for (const artifact of artifacts.filter((item) => item.emission === "bundle")) await emit(artifact);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = parseToolingOperation(process.argv.slice(2));
  if (operation === "help") console.log("Usage: node scripts/build-tooling.mts [--check | --maintainers-only]");
  else await buildTooling({ root: resolve(import.meta.dirname, ".."), operation });
}
