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
  statSync,
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
import {
  InvalidNodeCoverageReport,
  readNodeCoverageReports,
  type CoverageSourceMap,
  type NodeCoverageReport,
} from "./node-coverage-reports.mjs";
import { coverageRepository, reportCoverageChange, type MetricName } from "./coverage-summary.mjs";

import type { Profiler } from "node:inspector";
import type { CoverageMap, FileCoverageData } from "istanbul-lib-coverage";
import { required } from "./values.mjs";

interface MeasuredScript {
  code: string;
  included: Set<string>;
  url: string;
  executions: { result: Profiler.ScriptCoverage[] }[];
  sourceType: "script" | "module";
  map?: CoverageSourceMap;
}

function recordExecution(measured: MeasuredScript, script: NodeCoverageReport["result"][number]) {
  measured.executions.push({
    result: [{ ...script, scriptId: script.scriptId ?? script.url, url: measured.url }],
  });
  // Raw reports repeatedly contain the same large bundles. Bound retained ranges
  // while preserving the V8 merger's block-coverage precedence and execution counts.
  if (measured.executions.length === 32) measured.executions = [mergeProcessCovs(measured.executions)];
}

type CoveragePhase =
  | "workspace"
  | "tests"
  | "sourceMaps"
  | "subprocessReports"
  | "subprocessConversion"
  | "subprocess"
  | "reporting"
  | "cleanup";
type CoverageTiming = (phase: CoveragePhase, milliseconds: number, count?: number) => void;

export interface CoverageTimings {
  version: 1;
  totalMs: number;
  phases: Partial<Record<CoveragePhase, { milliseconds: number; count?: number }>>;
}

function phaseTimings(report?: CoverageTiming) {
  let started = performance.now();
  return (phase: CoveragePhase, count?: number) => {
    const now = performance.now();
    report?.(phase, now - started, count);
    started = now;
  };
}

// Integration tests launch and copy the distribution beside their test sources.
// Give coverage its own distribution without changing the runnable checkout.
export async function coverageWorkspace(root: string, temporary: string) {
  if (!["main", "skills"].every((name) => existsSync(join(root, `src/${name}.ts`)))) return root;
  const workspace = join(temporary, "project");
  mkdirSync(workspace);
  copySourceCheckout(root, workspace);
  // Reuse installed build/test dependencies; never copy or download them for coverage.
  const dependencies = realpathSync.native(join(root, "node_modules"));
  const destination = join(workspace, "node_modules");
  if (process.platform !== "win32") symlinkSync(dependencies, destination, "junction");
  else {
    // Resolve package targets before crossing drives: pnpm's relative package links
    // must retain their original virtual-store base through the disposable workspace.
    mkdirSync(destination);
    const link = (source: string, target: string) => {
      const canonical = realpathSync.native(source);
      symlinkSync(canonical, target, statSync(canonical).isDirectory() ? "junction" : "file");
    };
    for (const entry of readdirSync(dependencies)) {
      const source = join(dependencies, entry);
      const target = join(destination, entry);
      if (!entry.startsWith("@")) link(source, target);
      else {
        mkdirSync(target);
        for (const name of readdirSync(source)) link(join(source, name), join(target, name));
      }
    }
  }
  for (const name of ["main", "skills", "package", "launcher", "bootstrap"])
    if (existsSync(join(workspace, `src/${name}.ts`))) await build(bundleOptions(workspace, name, true));
  return workspace;
}

// Use the same AST-aware conversion as Vitest. Match full map contents before attributing a copied bundle.
export async function subprocessCoverage(directory: string, root: string, reportTiming?: CoverageTiming) {
  const phase = phaseTimings(reportTiming);
  const identity = (map: CoverageSourceMap, url: string) =>
    JSON.stringify(
      map.file ??
        map.sources.map((source) => {
          const directory = dirname(fileURLToPath(url));
          const path = source?.startsWith("file:")
            ? fileURLToPath(source)
            : resolve(directory, map.sourceRoot ?? "", source ?? "");
          return relative(directory, path).split(sep).join("/");
        }),
    );
  const bundles = new Map<string, MeasuredScript[]>();
  const helpers = new Map<string, MeasuredScript>();
  const sources = (directory: string): string[] => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) ? [path] : [];
    });
  };
  for (const path of ["bundle", "scripts", "bin"].flatMap((name) => sources(join(root, name)))) {
    const code = readFileSync(path, "utf8");
    const encoded = /sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([^\s]+)/.exec(code)?.[1];
    if (!encoded) {
      if (dirname(path) === join(root, "bundle") && path.endsWith(".cjs"))
        throw new Error(`${path}: bundle needs an inline source map`);
      continue;
    }
    const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CoverageSourceMap;
    const url = pathToFileURL(path).href;
    const key = identity(map, url);
    const included = new Set<string>();
    const mapped = {
      ...map,
      sources: map.sources.map((source, index) => {
        const sourcePath = resolve(dirname(path), map.sourceRoot ?? "", source ?? "");
        if (["src", "scripts", "bin"].some((name) => sourcePath.startsWith(join(root, name) + sep))) {
          if (!existsSync(sourcePath) || readFileSync(sourcePath, "utf8") !== map.sourcesContent?.[index])
            throw new Error(`${sourcePath}: emitted source differs from the checkout`);
          included.add(sourcePath);
        }
        // Relative URLs avoid treating Windows drive letters as URI schemes.
        return relative(dirname(path), sourcePath).split(sep).join("/");
      }),
    };
    const candidates = bundles.get(key) ?? [];
    candidates.push({
      code,
      map: mapped,
      included,
      url,
      executions: [],
      sourceType: path.endsWith(".cjs") ? "script" : "module",
    });
    bundles.set(key, candidates);
  }
  phase(
    "sourceMaps",
    [...bundles.values()].reduce((count, candidates) => count + candidates.length, 0),
  );
  let reportCount = 0;
  for (const data of readNodeCoverageReports(directory)) {
    reportCount++;
    for (const script of data.result) {
      const map = data["source-map-cache"]?.[script.url]?.data;
      if (map) {
        if (!script.url.startsWith("file:")) continue;
        // Index by portable identity, then compare every attributed map field exactly.
        // Re-serializing and hashing repeated multi-megabyte maps creates avoidable garbage.
        const candidates = (bundles.get(identity(map, script.url)) ?? []).filter(
          (candidate) =>
            map.mappings === candidate.map?.mappings &&
            isDeepStrictEqual(map.names, candidate.map.names) &&
            isDeepStrictEqual(map.sourcesContent, candidate.map.sourcesContent),
        );
        const bundle =
          candidates.find((candidate) => candidate.url === script.url) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        if (!bundle && candidates.length > 1)
          throw new Error(`${script.url}: copied coverage source is ambiguous; emit a unique source-map file identity`);
        if (!bundle) continue;
        recordExecution(bundle, script);
        continue;
      }
      if (!script.url.startsWith("file:")) continue;
      const path = fileURLToPath(script.url);
      if (!/^(?:scripts\/.*|bin\/[^/]+)\.(?:js|mjs|cjs)$/.test(relative(root, path).split(sep).join("/"))) continue;
      if (!existsSync(path)) throw new Error(`${path}: measured helper is missing from the checkout`);
      let helper = helpers.get(path);
      if (!helper) {
        helper = {
          code: readFileSync(path, "utf8"),
          included: new Set([path]),
          url: script.url,
          executions: [],
          sourceType: path.endsWith(".cjs") ? "script" : "module",
        };
        helpers.set(path, helper);
      }
      recordExecution(helper, script);
    }
  }
  phase("subprocessReports", reportCount);
  const map = coverage.createCoverageMap({});
  let convertedScripts = 0;
  for (const bundle of [...[...bundles.values()].flat(), ...helpers.values()]) {
    const merged = mergeProcessCovs(bundle.executions);
    bundle.executions.length = 0;
    if (!merged.result.length) continue;
    convertedScripts++;
    const converted = await convert({
      code: bundle.code,
      ast: parse(bundle.code, { ecmaVersion: "latest", locations: true, sourceType: bundle.sourceType }),
      wrapperLength: 0,
      coverage: required(merged.result[0], "Merged coverage must retain its script"),
      ...(bundle.map ? { sourceMap: bundle.map } : {}),
      // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
      ignoreSourceCode: (code) => code.trim() === "export",
    });
    map.merge(
      Object.fromEntries(
        Object.entries(converted).flatMap(([path, value]) => {
          const absolute = resolve(path);
          return bundle.included.has(absolute)
            ? [[absolute, { ...coverage.createFileCoverage(value).data, path: absolute }]]
            : [];
        }),
      ),
    );
  }
  phase("subprocessConversion", convertedScripts);
  return map;
}

export function mergeCoverage(
  paths: string[],
  directory: string,
  thresholds: Partial<Record<MetricName, number>>,
  sourceRoot = process.cwd(),
  reportRoot = sourceRoot,
  present?: (map: CoverageMap) => void,
) {
  const map = coverage.createCoverageMap({});
  for (const path of paths) {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, FileCoverageData>;
    const remapped =
      sourceRoot === reportRoot
        ? data
        : Object.fromEntries(
            Object.entries(data).map(([file, value]) => {
              const absolute = resolve(file);
              if (!absolute.startsWith(sourceRoot + sep)) throw new Error(`coverage path outside workspace: ${file}`);
              const canonical = join(reportRoot, relative(sourceRoot, absolute));
              return [canonical, { ...value, path: canonical }];
            }),
          );
    map.merge(remapped);
  }
  const context = report.createContext({ dir: directory, coverageMap: map });
  for (const name of ["text", "json-summary", "json"] as const) reports.create(name).execute(context);
  present?.(map);
  const summary = map.getCoverageSummary();
  if (!summary.lines.total || !summary.functions.total)
    throw new Error("coverage contains no measured lines or functions");
  for (const metric of ["lines", "functions", "branches", "statements"] as const) {
    const minimum = thresholds[metric];
    const percentage = summary[metric].pct;
    if (minimum !== undefined && (typeof percentage !== "number" || percentage < minimum))
      throw new Error(`${metric} coverage ${String(percentage)}% is below ${String(minimum)}%`);
  }
  return map;
}

export async function runCoverage(root: string, builds = join(root, "build")) {
  const started = performance.now();
  const timings: CoverageTimings = { version: 1, totalMs: 0, phases: {} };
  const reportTiming: CoverageTiming = (phase, milliseconds, count) => {
    timings.phases[phase] = { milliseconds, ...(count === undefined ? {} : { count }) };
    console.error(`Coverage ${phase}: ${(milliseconds / 1000).toFixed(2)}s`);
  };
  const phase = phaseTimings(reportTiming);
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
    phase("workspace");
    const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: coverageRepository(root), encoding: "utf8" });
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
      const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
      // Dedicated coverage reports retain the map; test evidence retains outcomes, diagnostics, and timings.
      delete results.coverageMap;
      const remap = (value: unknown): unknown => {
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
    phase("tests");
    if (tests.error || tests.status !== 0) throw new Error("tests or coverage collection failed");
    const cli = join(temporary, "cli.json");
    writeFileSync(cli, JSON.stringify(await subprocessCoverage(raw, workspace, reportTiming)));
    phase("subprocess");
    const policy = (
      JSON.parse(readFileSync(join(root, "workbench/quality.json"), "utf8")) as { coverage: Record<MetricName, number> }
    ).coverage;
    const map = mergeCoverage(
      [join(unit, "coverage-final.json"), cli],
      output,
      Object.fromEntries((["lines", "functions", "branches", "statements"] as const).map((key) => [key, policy[key]])),
      workspace,
      resolve(root),
      (map: coverage.CoverageMap) => reportCoverageChange(map, resolve(root), join(output, "coverage-summary.json")),
    );
    phase("reporting");
    return map;
  } catch (error) {
    if (error instanceof InvalidNodeCoverageReport) {
      const diagnostic = join(output, "collection-error.json");
      writeFileSync(diagnostic, JSON.stringify(error.diagnostic, null, 2) + "\n");
      console.error(`Coverage collection diagnostics: ${diagnostic}`);
    }
    throw error;
  } finally {
    // Raw V8 output contains repeated source maps and can dwarf the final reports.
    const cleanupStarted = performance.now();
    rmSync(temporary, { recursive: true, force: true });
    reportTiming("cleanup", performance.now() - cleanupStarted);
    timings.totalMs = performance.now() - started;
    try {
      writeFileSync(join(output, "timings.json"), JSON.stringify(timings, null, 2) + "\n");
    } catch {
      // Observational timing output must not replace a test or collection failure.
      console.error("Coverage timings could not be written.");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runCoverage(process.cwd(), process.env.WORKBENCH_BUILD_DIR);
