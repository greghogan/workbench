import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse } from "acorn";
import convert from "ast-v8-to-istanbul";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import coverage from "istanbul-lib-coverage";
import report from "istanbul-lib-report";
import reports from "istanbul-reports";
import { build } from "esbuild";
import { copySourceCheckout } from "./source-checkout.mjs";
import { bundleOptions } from "./bundle-options.mjs";
import { reportCoverageChange } from "./coverage-summary.mjs";

// Integration tests launch and copy the distribution beside their test sources.
// Give coverage its own distribution without changing the runnable checkout.
export async function coverageWorkspace(root, temporary) {
  if (!["main", "skills"].every((name) => existsSync(join(root, `src/${name}.ts`)))) return root;
  const workspace = join(temporary, "project");
  mkdirSync(workspace);
  copySourceCheckout(root, workspace);
  // Reuse installed build/test dependencies; never copy or download them for coverage.
  symlinkSync(realpathSync.native(join(root, "node_modules")), join(workspace, "node_modules"), "junction");
  for (const name of ["main", "skills"]) await build(bundleOptions(workspace, name, true));
  return workspace;
}

// Use the same AST-aware conversion as Vitest. Match full map contents before attributing a copied bundle.
export async function subprocessCoverage(directory, root) {
  const identity = (map) =>
    createHash("sha256")
      .update(JSON.stringify([map.mappings, map.sourcesContent, map.names]))
      .digest("hex");
  const bundles = new Map();
  for (const name of readdirSync(join(root, "bundle"))) {
    if (!name.endsWith(".cjs")) continue;
    const path = join(root, "bundle", name);
    const code = readFileSync(path, "utf8");
    const encoded = /sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([^\s]+)/.exec(code)?.[1];
    if (!encoded) throw new Error(`${path}: bundle needs an inline source map`);
    const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const key = identity(map);
    const included = new Set();
    map.sources = map.sources.map((source, index) => {
      const sourcePath = resolve(dirname(path), source);
      if (sourcePath.startsWith(join(root, "src") + sep)) {
        if (!existsSync(sourcePath) || readFileSync(sourcePath, "utf8") !== map.sourcesContent[index])
          throw new Error(`${sourcePath}: bundle source differs from the checkout`);
        included.add(sourcePath);
      }
      // Relative URLs avoid treating Windows drive letters as URI schemes, and preserve
      // the converter's source-content lookup using native filesystem paths.
      return relative(dirname(path), sourcePath).split(sep).join("/");
    });
    bundles.set(key, { code, map, included, url: pathToFileURL(path).href, executions: [] });
  }
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch (cause) {
      throw new Error(`Invalid Node coverage report: ${name}`, { cause });
    }
    for (const script of data.result ?? []) {
      const map = data["source-map-cache"]?.[script.url]?.data;
      if (!map) continue;
      const bundle = bundles.get(identity(map));
      if (!bundle || !isDeepStrictEqual(map.sourcesContent, bundle.map.sourcesContent)) continue;
      bundle.executions.push({ result: [{ ...script, url: bundle.url }] });
    }
  }
  const map = coverage.createCoverageMap({});
  for (const bundle of bundles.values()) {
    const merged = mergeProcessCovs(bundle.executions);
    if (!merged.result.length) continue;
    const converted = await convert({
      code: bundle.code,
      ast: parse(bundle.code, { ecmaVersion: "latest", locations: true, sourceType: "script" }),
      wrapperLength: 0,
      coverage: merged.result[0],
      sourceMap: bundle.map,
      // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
      ignoreSourceCode: (code) => code.trim() === "export",
    });
    map.merge(
      Object.fromEntries(
        Object.entries(converted).flatMap(([path, value]) => {
          const absolute = resolve(path);
          return bundle.included.has(absolute) ? [[absolute, { ...value, path: absolute }]] : [];
        }),
      ),
    );
  }
  return map;
}

export function mergeCoverage(paths, directory, thresholds, sourceRoot, reportRoot = sourceRoot, present) {
  const map = coverage.createCoverageMap({});
  for (const path of paths) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (sourceRoot !== reportRoot)
      for (const [file, value] of Object.entries(data)) {
        const absolute = resolve(file);
        if (!absolute.startsWith(sourceRoot + sep)) throw new Error(`coverage path outside workspace: ${file}`);
        const canonical = join(reportRoot, relative(sourceRoot, absolute));
        delete data[file];
        data[canonical] = { ...value, path: canonical };
      }
    map.merge(data);
  }
  const context = report.createContext({ dir: directory, coverageMap: map });
  for (const name of ["text", "json-summary", "json"]) reports.create(name).execute(context);
  present?.(map);
  const summary = map.getCoverageSummary();
  if (!summary.lines.total || !summary.functions.total)
    throw new Error("coverage contains no measured lines or functions");
  for (const [metric, minimum] of Object.entries(thresholds))
    if (summary[metric].pct < minimum)
      throw new Error(`${metric} coverage ${summary[metric].pct}% is below ${minimum}%`);
  return map;
}

export async function runCoverage(root, builds = join(root, "build")) {
  root = realpathSync.native(root);
  const output = join(root, "coverage");
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error("coverage must be a real directory");
  mkdirSync(output, { recursive: true });
  // Preserve the tracked baseline if test collection fails before a replacement exists.
  for (const name of readdirSync(output))
    if (name !== "coverage-summary.json") rmSync(join(output, name), { recursive: true, force: true });
  const summaryPath = join(output, "coverage-summary.json");
  if (existsSync(summaryPath) && lstatSync(summaryPath).isSymbolicLink())
    throw new Error("coverage summary must be a regular file");
  mkdirSync(builds, { recursive: true });
  const temporary = mkdtempSync(join(realpathSync.native(builds), "coverage-"));
  try {
    const workspace = await coverageWorkspace(resolve(root), temporary);
    const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const revision = process.env.WORKBENCH_SOURCE_REVISION ?? (source.status === 0 ? source.stdout.trim() : undefined);
    const raw = join(temporary, "raw");
    const unit = join(temporary, "unit");
    const tests = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--coverage", "--coverage.reportsDirectory", unit],
      {
        cwd: workspace,
        stdio: "inherit",
        // Vitest already measures its workers. Their setup enables native V8 capture only for CLI children.
        env: {
          ...process.env,
          NODE_V8_COVERAGE: "",
          WORKBENCH_SUBPROCESS_COVERAGE: raw,
          ...(revision === undefined ? {} : { WORKBENCH_SOURCE_REVISION: revision }),
        },
      },
    );
    const resultsPath = join(workspace, "coverage/tests.json");
    if (existsSync(resultsPath)) {
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      // Dedicated coverage reports retain the map; test evidence retains outcomes, diagnostics, and timings.
      delete results.coverageMap;
      const remap = (value) => {
        if (typeof value === "string")
          return value
            .replaceAll(workspace + sep, resolve(root) + sep)
            .replaceAll(workspace.replaceAll(sep, "/") + "/", resolve(root).replaceAll(sep, "/") + "/");
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === "object")
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
        return value;
      };
      writeFileSync(join(output, "tests.json"), JSON.stringify(remap(results)));
    }
    if (tests.error || tests.status !== 0) throw new Error("tests or coverage collection failed");
    const cli = join(temporary, "cli.json");
    writeFileSync(cli, JSON.stringify(await subprocessCoverage(raw, workspace)));
    const policy = JSON.parse(readFileSync(join(root, "workbench/quality.json"), "utf8")).coverage;
    return mergeCoverage(
      [join(unit, "coverage-final.json"), cli],
      output,
      Object.fromEntries(["lines", "functions", "branches", "statements"].map((key) => [key, policy[key]])),
      workspace,
      resolve(root),
      (map) => reportCoverageChange(map, resolve(root), join(output, "coverage-summary.json")),
    );
  } finally {
    // Raw V8 output contains repeated source maps and can dwarf the final reports.
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runCoverage(process.cwd(), process.env.WORKBENCH_BUILD_DIR);
