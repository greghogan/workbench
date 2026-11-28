import { bundleSource } from "../app/src/core/distribution/bundle-artifacts.mjs";
import { isMainScript } from "./script-entry.mjs";
import { admittedWork, type WorkAdmission } from "../app/src/core/execution/checks/work-admission.mjs";
import { testFailureSummary } from "./test-failures.mjs";
import { createOwnedScratch } from "../app/src/core/runtime/owned-scratch.mjs";
import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { linkDependencies } from "./link-dependencies.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { copySourceCheckout } from "../app/src/core/execution/snapshots/source-checkout.mjs";
import { bundleOptions } from "./bundle-options.mjs";
import { bundleEntries } from "./bundle-build.mjs";
import {
  drainNodeCoverageReports,
  InvalidNodeCoverageReport,
  nodeCoverageProducer,
  coverageWriteError,
  type CoverageCollection,
  type CoverageSourceMap,
} from "./node-coverage-reports.mjs";
import {
  coverageRepository,
  reportCoverageChange,
  type MetricName,
} from "../app/src/core/execution/checks/coverage-summary.mjs";

import type { CoverageMap, FileCoverageData } from "istanbul-lib-coverage";
import { required } from "../app/src/core/runtime/values.mjs";

import {
  CoverageAccumulator,
  collectedScriptCoverage,
  coverageMapReference,
  coverageMapReferencePrefix,
  convertCoverageScript,
  type MeasuredScript,
  type ScannedCoverage,
} from "./coverage-processing.mjs";
import { coverageJobs, coverageReaders } from "./coverage-workers.mjs";
import { cpuBudget } from "../app/src/core/execution/checks/cpu-budget.mjs";
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
  collection?: CoverageCollection;
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
interface CoverageWorkspace {
  root: string;
  maps: ReadonlyMap<string, CoverageSourceMap>;
}

export async function coverageWorkspace(root: string, temporary: string, reuseSource = false) {
  const maps = new Map<string, CoverageSourceMap>();
  if (!["main", "skills"].every((name) => existsSync(join(root, bundleSource(name))))) return { root, maps };
  const workspace = reuseSource ? root : join(temporary, "project");
  if (!reuseSource) {
    mkdirSync(workspace);
    copySourceCheckout(root, workspace);
    linkDependencies(join(root, "node_modules"), join(workspace, "node_modules"));
  }
  mkdirSync(join(workspace, "bundle"), { recursive: true });
  for (const name of bundleEntries) {
    if (!existsSync(join(workspace, bundleSource(name)))) continue;
    const options = bundleOptions(workspace, name, true);
    const { outputFiles } = await build({ ...options, sourcemap: "external", write: false });
    const executable = required(
      outputFiles.find(({ path }) => path.endsWith(".cjs")),
      "Missing coverage bundle",
    );
    const sourceMap = required(
      outputFiles.find(({ path }) => path === executable.path + ".map"),
      "Missing source map",
    );
    const reference =
      coverageMapReferencePrefix +
      createHash("sha256")
        .update(name)
        .update("\0")
        .update(executable.contents)
        .update("\0")
        .update(sourceMap.contents)
        .digest("hex");
    maps.set(reference, JSON.parse(sourceMap.text) as CoverageSourceMap);
    // Node repeats an inline map in each report. Keep the full map in the collector and carry only its build identity.
    const marker = { version: 3, file: reference, sources: [], names: [], mappings: "" };
    const encoded = Buffer.from(JSON.stringify(marker)).toString("base64");
    writeFileSync(
      executable.path,
      executable.text + "//# sourceMappingURL=data:application/json;base64," + encoded + "\n",
    );
  }
  return { root: workspace, maps };
}

export function coverageConcurrency(cpus: number, availableBytes: number): number {
  return Math.max(1, Math.min(cpus, Math.floor(availableBytes / (2 * 1024 ** 3))));
}

function coverageScripts(root: string, maps?: CoverageWorkspace["maps"]): MeasuredScript[] {
  const candidates: MeasuredScript[] = [];
  const sources = (directory: string): string[] => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) ? [path] : [];
    });
  };
  for (const path of ["bundle", "scripts", "bin", "app/src"].flatMap((name) => sources(join(root, name)))) {
    const code = readFileSync(path, "utf8");
    const encoded = /^\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([\w+/=]+)$/m.exec(
      code,
    )?.[1];
    if (!encoded) {
      if (dirname(path) === join(root, "bundle") && path.endsWith(".cjs"))
        throw new Error(`${path}: bundle needs an inline source map`);
      continue;
    }
    const inline = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CoverageSourceMap;
    const reference = coverageMapReference(inline);
    const map = reference ? required(maps?.get(reference), `${path}: missing captured coverage map`) : inline;
    const url = pathToFileURL(path).href;
    const included = new Set<string>();
    const mapped = {
      ...map,
      sources: map.sources.map((source, index) => {
        const sourcePath = resolve(dirname(path), map.sourceRoot ?? "", source ?? "");
        if (
          ["src", "app/src", "app/test/integration/consumers", "app/test/integration/browser", "scripts", "bin"].some(
            (name) => sourcePath.startsWith(join(root, name) + sep),
          )
        ) {
          if (!existsSync(sourcePath) || readFileSync(sourcePath, "utf8") !== map.sourcesContent?.[index])
            throw new Error(`${sourcePath}: emitted source differs from the checkout`);
          included.add(sourcePath);
        }
        // Same-drive paths remain relative; conversion uses file URLs only across Windows drives.
        return relative(dirname(path), sourcePath).split(sep).join("/");
      }),
    };
    candidates.push({
      code,
      map: mapped,
      ...(reference ? { mapReference: reference } : {}),
      included,
      url,
      sourceType: path.endsWith(".cjs") ? "script" : "module",
    });
  }
  return candidates;
}

export async function subprocessCoverage(
  directory: string,
  source: string | CoverageWorkspace,
  reportTiming?: CoverageTiming,
  signal?: AbortSignal,
  admission?: WorkAdmission,
) {
  const phase = phaseTimings(reportTiming);
  // Node records canonical file URLs, including macOS's /var -> /private/var temporary roots.
  const root = realpathSync.native(typeof source === "string" ? source : source.root);
  const candidates = coverageScripts(root, typeof source === "string" ? undefined : source.maps);
  phase("sourceMaps", candidates.length);
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const readers = await coverageReaders(
    { directory, root, candidates: scanCandidates(candidates) },
    {
      capacity: Math.min(collectionConcurrency(), Math.max(files.length, 1)),
      ...(signal ? { signal } : {}),
      ...(admission ? { admission } : {}),
    },
  );
  let collected: ScannedCoverage;
  try {
    const drain = drainNodeCoverageReports(directory, readers.readers, {
      mode: "read-once",
      ...(signal ? { signal } : {}),
    });
    await drain.finish();
    collected = mergeCollectedCoverage(root, candidates, await readers.finish());
  } finally {
    await readers.close();
  }
  phase("subprocessReports", files.length);
  return convertSubprocessCoverage(candidates, collected, reportTiming, signal, admission);
}

function collectionConcurrency() {
  // Leave CPU and memory headroom for the test producers.
  return Math.max(
    1,
    Math.min(4, Math.floor(cpuBudget() / 2), coverageConcurrency(cpuBudget(), process.availableMemory())),
  );
}

function scanCandidates(candidates: MeasuredScript[]) {
  return candidates.map(({ url, map, mapReference }) => ({
    url,
    ...(mapReference ? { mapReference } : map ? { map } : {}),
  }));
}

function mergeCollectedCoverage(root: string, candidates: MeasuredScript[], reports: ScannedCoverage[]) {
  if (reports.length === 1) return required(reports[0], "Missing coverage result");
  const accumulator = new CoverageAccumulator(root, scanCandidates(candidates));
  for (const result of reports) accumulator.merge(result);
  return accumulator.result();
}

async function convertSubprocessCoverage(
  candidates: MeasuredScript[],
  collected: ScannedCoverage,
  reportTiming?: CoverageTiming,
  signal?: AbortSignal,
  admission?: WorkAdmission,
) {
  const phase = phaseTimings(reportTiming);
  const byURL = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const measured = collected.bundles.map((entry) => ({
    script: required(byURL.get(entry.url), "Unknown measured bundle"),
    entry,
  }));
  for (const entry of collected.helpers) {
    const path = fileURLToPath(entry.url);
    measured.push({
      entry,
      script: {
        url: entry.url,
        code: readFileSync(path, "utf8"),
        included: new Set([path]),
        sourceType: path.endsWith(".cjs") ? "script" : "module",
      },
    });
  }
  measured.sort((left, right) => right.script.code.length - left.script.code.length);
  const jobs = measured.map(({ script, entry }) => ({
    kind: "convert" as const,
    script,
    execution: collectedScriptCoverage(entry),
  }));
  // AST/source-map processing is memory intensive. Retain headroom on small CI hosts.
  const concurrency = coverageConcurrency(cpuBudget(), process.availableMemory());
  const converted =
    concurrency > 1 && jobs.length > 1
      ? await coverageJobs(jobs, {
          capacity: concurrency,
          ...(signal ? { signal } : {}),
          ...(admission ? { admission } : {}),
        })
      : await Promise.all(
          jobs.map(({ script, execution }) =>
            admittedWork(admission, signal, () => convertCoverageScript(script, execution)),
          ),
        );
  const map = coverage.createCoverageMap({});
  for (const result of converted) map.merge(result);
  phase("subprocessConversion", measured.length);
  return map;
}

export function mergeCoverage(
  inputs: (string | CoverageMap)[],
  directory: string,
  thresholds: Partial<Record<MetricName, number>>,
  sourceRoot = process.cwd(),
  reportRoot = sourceRoot,
  present?: (map: CoverageMap) => void,
) {
  const map = coverage.createCoverageMap({});
  for (const input of inputs) {
    const data =
      typeof input === "string"
        ? (JSON.parse(readFileSync(input, "utf8")) as Record<string, FileCoverageData>)
        : Object.fromEntries(input.files().map((file) => [file, input.fileCoverageFor(file).data]));
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
  for (const name of ["text", "json"] as const) reports.create(name).execute(context);
  const summary = map.getCoverageSummary();
  if (!summary.lines.total || !summary.functions.total)
    throw new Error("coverage contains no measured lines or functions");
  for (const metric of ["lines", "functions", "branches", "statements"] as const) {
    const minimum = thresholds[metric];
    const percentage = summary[metric].pct;
    if (minimum !== undefined && (typeof percentage !== "number" || percentage < minimum))
      throw new Error(`${metric} coverage ${String(percentage)}% is below ${String(minimum)}%`);
  }
  if (present) present(map);
  else reports.create("json-summary").execute(context);
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
  let collectionFailure: Error | undefined;
  let measured: CoverageMap | undefined;
  const raw = join(temporary, "raw");
  let drain: ReturnType<typeof drainNodeCoverageReports> | undefined;
  let readers: Awaited<ReturnType<typeof coverageReaders>> | undefined;
  try {
    const captured = await coverageWorkspace(
      resolve(root),
      temporary,
      process.env.WORKBENCH_CHECK_SCOPED === "1" && process.env.WORKBENCH_CHECK_PRIVATE_BUNDLE === "1",
    );
    const workspace = realpathSync.native(captured.root);
    phase("workspace");
    const candidates = coverageScripts(workspace, captured.maps);
    phase("sourceMaps", candidates.length);
    mkdirSync(raw);
    readers = await coverageReaders(
      { directory: raw, root: workspace, candidates: scanCandidates(candidates) },
      {
        capacity: collectionConcurrency(),
        signal: cancellation.signal,
        ...(options.admission ? { admission: options.admission } : {}),
      },
    );
    drain = drainNodeCoverageReports(raw, readers.readers, { signal: cancellation.signal });
    const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: coverageRepository(root), encoding: "utf8" });
    const revision = process.env.WORKBENCH_SOURCE_REVISION ?? (source.status === 0 ? source.stdout.trim() : undefined);
    const unit = join(temporary, "unit");
    let writeFailure: Error | undefined;
    cancellation.signal.throwIfAborted();
    const tests = await runOwnedChild(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--configLoader",
        "native",
        "--coverage",
        "--coverage.reportsDirectory",
        unit,
        "--fsModuleCachePath",
        join(temporary, "vitest-modules"),
      ],
      {
        cwd: workspace,
        signal: cancellation.signal,
        owner: scratch.owner,
        output: (stdout, stderr) => {
          for (const [stream, target] of [
            [stdout, process.stdout],
            [stderr, process.stderr],
          ] as const) {
            let tail = "";
            stream.setEncoding("utf8").on("data", (chunk: string) => {
              if (writeFailure) return;
              const text = tail + chunk;
              const newline = text.lastIndexOf("\n");
              if (newline < 0) {
                tail = text.slice(-8192);
                return;
              }
              writeFailure = coverageWriteError(raw, text.slice(0, newline + 1));
              tail = text.slice(newline + 1).slice(-8192);
            });
            stream.once("end", () => {
              writeFailure ??= coverageWriteError(raw, tail);
            });
            stream.pipe(target, { end: false });
          }
        },
        // Vitest already measures its workers. Their setup enables native V8 capture only for CLI children.
        env: {
          ...process.env,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_V8_COVERAGE: "",
          WORKBENCH_SUBPROCESS_COVERAGE: raw,
          ...(revision === undefined ? {} : { WORKBENCH_SOURCE_REVISION: revision }),
        },
      },
    );
    testFailure = processFailure("tests or coverage collection", tests);
    try {
      cancellation.signal.throwIfAborted();
      const collection = await drain.finish();
      timings.collection = collection;
      reportTiming("subprocessReports", collection.readMilliseconds + collection.mergeMilliseconds, collection.count);
      console.error(
        "Coverage collected " +
          String(collection.bytes) +
          " raw bytes; final drain " +
          (collection.finalDrainMilliseconds / 1000).toFixed(2) +
          "s",
      );
      if (writeFailure) throw writeFailure;
    } catch (error) {
      collectionFailure = error instanceof Error ? error : new Error("Coverage collection failed", { cause: error });
    }
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
    if (collectionFailure !== undefined) throw collectionFailure;
    cancellation.signal.throwIfAborted();
    if (testFailure) throw testFailure;
    const collected = mergeCollectedCoverage(workspace, candidates, await readers.finish());
    await readers.close();
    readers = undefined;
    const cli = await convertSubprocessCoverage(
      candidates,
      collected,
      reportTiming,
      cancellation.signal,
      options.admission,
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
    if (collectionFailure && collectionFailure !== error) failures.push(collectionFailure);
    failures.push(error);
    const invalid = collectionFailure ?? error;
    if (invalid instanceof InvalidNodeCoverageReport) {
      const diagnostic = join(output, "collection-error.json");
      try {
        writeFileSync(
          diagnostic,
          JSON.stringify({ ...invalid.diagnostic, producer: nodeCoverageProducer(raw, invalid.diagnostic) }, null, 2) +
            "\n",
        );
        console.error(`Coverage collection diagnostics: ${diagnostic}`);
      } catch (cause) {
        failures.push(new Error("Coverage collection diagnostics could not be written", { cause }));
      }
    }
  } finally {
    const cleanupStarted = performance.now();
    try {
      await drain?.stop();
    } catch (cause) {
      failures.push(new Error("Coverage collector cleanup failed", { cause }));
    }
    try {
      await readers?.close();
    } catch (cause) {
      failures.push(new Error("Coverage workers cleanup failed", { cause }));
    }
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

if (isMainScript(import.meta.url)) await runCoverage(process.cwd(), process.env.WORKBENCH_BUILD_DIR);
