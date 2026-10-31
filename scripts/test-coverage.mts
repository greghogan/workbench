import { admittedWork, type WorkAdmission } from "./work-admission.mjs";
import { testFailureSummary } from "./test-failures.mjs";
import { createOwnedScratch } from "./owned-scratch.mjs";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { linkDependencies } from "./link-dependencies.mjs";
import { processFailure } from "./process-outcome.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
import { InvalidNodeCoverageReport, type CoverageSourceMap } from "./node-coverage-reports.mjs";
import { coverageRepository, reportCoverageChange, type MetricName } from "./coverage-summary.mjs";

import type { CoverageMap, FileCoverageData } from "istanbul-lib-coverage";
import { required } from "./values.mjs";

import {
  mapIdentity,
  scanCoverageReports,
  convertCoverageScript,
  recordExecution,
  type MeasuredScript,
} from "./coverage-processing.mjs";
import { coverageJobs } from "./coverage-workers.mjs";
import { cpuBudget } from "./cpu-budget.mjs";
import { availableParallelism, loadavg } from "node:os";

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
  execution: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
    availableCPUs: number;
    workerBudget: number;
    startedAt: string;
    loadAverageStart: number[] | null;
    loadAverageEnd?: number[] | null;
  };
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
  linkDependencies(join(root, "node_modules"), join(workspace, "node_modules"));
  for (const name of ["main", "skills", "package", "consumer", "launcher", "bootstrap"])
    if (existsSync(join(workspace, `src/${name}.ts`))) await build(bundleOptions(workspace, name, true));
  return workspace;
}

// Use the same AST-aware conversion as Vitest. Match full map contents before attributing a copied bundle.
export async function subprocessCoverage(
  directory: string,
  root: string,
  reportTiming?: CoverageTiming,
  signal?: AbortSignal,
  admission?: WorkAdmission,
) {
  const phase = phaseTimings(reportTiming);
  // Node records canonical file URLs, including macOS's /var -> /private/var temporary roots.
  root = realpathSync.native(root);
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
    const key = mapIdentity(map, url);
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
        // Same-drive paths remain relative; conversion uses file URLs only across Windows drives.
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
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const concurrency = Math.min(4, cpuBudget());
  const candidates = [...bundles.values()].flat();
  const descriptors = candidates.map(({ url, map }) => ({ url, ...(map ? { map } : {}) }));
  const byURL = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const consume = (scan: ReturnType<typeof scanCoverageReports>) => {
    for (const result of scan.bundles) {
      const candidate = required(byURL.get(result.url), "Unknown measured bundle");
      for (const execution of result.executions)
        for (const script of execution.result) recordExecution(candidate, script);
    }
    for (const helper of scan.helpers) {
      const previous = helpers.get(helper.url);
      if (!previous) helpers.set(helper.url, helper);
      else
        for (const execution of helper.executions)
          for (const script of execution.result) recordExecution(previous, script);
    }
  };
  const workers = Math.min(concurrency, files.length);
  if (workers > 1)
    await coverageJobs(
      files.map((file) => ({ kind: "scan" as const, directory, root, candidates: descriptors, files: [file] })),
      { capacity: workers, consume, ...(signal ? { signal } : {}), ...(admission ? { admission } : {}) },
    );
  else
    consume(
      await admittedWork(admission, signal, () =>
        Promise.resolve(scanCoverageReports(directory, root, descriptors, files)),
      ),
    );
  phase("subprocessReports", files.length);
  const measured = [...candidates, ...helpers.values()].filter((script) => script.executions.length);
  const converted =
    concurrency > 1 && measured.length > 1
      ? await coverageJobs(
          measured.map((script) => ({ kind: "convert" as const, script })),
          { capacity: concurrency, ...(signal ? { signal } : {}), ...(admission ? { admission } : {}) },
        )
      : await Promise.all(
          measured.map((script) => admittedWork(admission, signal, () => convertCoverageScript(script))),
        );
  const map = coverage.createCoverageMap({});
  for (const result of converted) map.merge(result);
  phase("subprocessConversion", measured.length);
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

export async function runCoverage(
  root: string,
  builds = join(root, "build"),
  options: { admission?: WorkAdmission } = {},
) {
  const started = performance.now();
  const timings: CoverageTimings = {
    version: 1,
    totalMs: 0,
    phases: {},
    execution: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      availableCPUs: availableParallelism(),
      workerBudget: cpuBudget(),
      startedAt: new Date().toISOString(),
      loadAverageStart: process.platform === "win32" ? null : loadavg(),
    },
  };
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
  const scratch = createOwnedScratch(realpathSync.native(builds), "coverage");
  const temporary = scratch.directory;
  const cancellation = processCancellation();
  const failures: unknown[] = [];
  let testFailure: Error | undefined;
  let measured: CoverageMap | undefined;
  try {
    const workspace = await coverageWorkspace(resolve(root), temporary);
    phase("workspace");
    const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: coverageRepository(root), encoding: "utf8" });
    const revision = process.env.WORKBENCH_SOURCE_REVISION ?? (source.status === 0 ? source.stdout.trim() : undefined);
    const raw = join(temporary, "raw");
    const unit = join(temporary, "unit");
    cancellation.signal.throwIfAborted();
    const tests = await runOwnedChild(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--coverage", "--coverage.reportsDirectory", unit],
      {
        cwd: workspace,
        signal: cancellation.signal,
        owner: scratch.owner,
        // Vitest already measures its workers. Their setup enables native V8 capture only for CLI children.
        env: {
          ...process.env,
          NODE_V8_COVERAGE: "",
          WORKBENCH_SUBPROCESS_COVERAGE: raw,
          ...(revision === undefined ? {} : { WORKBENCH_SOURCE_REVISION: revision }),
        },
      },
    );
    testFailure = processFailure("tests or coverage collection", tests);
    const resultsPath = join(workspace, "coverage/tests.json");
    if (existsSync(resultsPath)) {
      const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
      const summary = testFailureSummary(results);
      if (testFailure && summary) testFailure = new Error(summary, { cause: testFailure });
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
    cancellation.signal.throwIfAborted();
    if (testFailure) throw testFailure;
    const cli = join(temporary, "cli.json");
    writeFileSync(
      cli,
      JSON.stringify(await subprocessCoverage(raw, workspace, reportTiming, cancellation.signal, options.admission)),
    );
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
    measured = map;
  } catch (error) {
    if (testFailure && error !== testFailure) failures.push(testFailure);
    failures.push(error);
    if (error instanceof InvalidNodeCoverageReport) {
      const diagnostic = join(output, "collection-error.json");
      try {
        writeFileSync(diagnostic, JSON.stringify(error.diagnostic, null, 2) + "\n");
        console.error(`Coverage collection diagnostics: ${diagnostic}`);
      } catch (cause) {
        failures.push(new Error("Coverage collection diagnostics could not be written", { cause }));
      }
    }
  } finally {
    // Raw V8 output contains repeated source maps and can dwarf the final reports.
    const cleanupStarted = performance.now();
    try {
      scratch.release();
    } catch (cause) {
      failures.push(new Error("Coverage scratch cleanup failed", { cause }));
    }
    cancellation.close();
    reportTiming("cleanup", performance.now() - cleanupStarted);
    timings.totalMs = performance.now() - started;
    timings.execution.loadAverageEnd = process.platform === "win32" ? null : loadavg();
    try {
      writeFileSync(join(output, "timings.json"), JSON.stringify(timings, null, 2) + "\n");
    } catch (cause) {
      // Observational timing output must not replace a test or collection failure.
      console.error("Coverage timings could not be written.");
      if (failures.length) failures.push(new Error("Coverage timings could not be written", { cause }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "), { cause: failures[0] });
  return required(measured, "Successful coverage run must retain its measured map");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runCoverage(process.cwd(), process.env.WORKBENCH_BUILD_DIR);
