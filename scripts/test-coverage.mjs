// Generated from test-coverage.mts; edit the TypeScript source.
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
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import coverage from "istanbul-lib-coverage";
import report from "istanbul-lib-report";
import reports from "istanbul-reports";
import { build } from "esbuild";
import { copySourceCheckout } from "./source-checkout.mjs";
import { bundleOptions } from "./bundle-options.mjs";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { coverageRepository, reportCoverageChange } from "./coverage-summary.mjs";
import { required } from "./values.mjs";
import {
  mapIdentity,
  scanCoverageReports,
  convertCoverageScript,
  recordExecution
} from "./coverage-processing.mjs";
import { coverageJobs } from "./coverage-workers.mjs";
import { cpuBudget } from "./cpu-budget.mjs";
function phaseTimings(report2) {
  let started = performance.now();
  return (phase, count) => {
    const now = performance.now();
    report2?.(phase, now - started, count);
    started = now;
  };
}
async function coverageWorkspace(root, temporary) {
  if (!["main", "skills"].every((name) => existsSync(join(root, `src/${name}.ts`)))) return root;
  const workspace = join(temporary, "project");
  mkdirSync(workspace);
  copySourceCheckout(root, workspace);
  const dependencies = realpathSync.native(join(root, "node_modules"));
  const destination = join(workspace, "node_modules");
  if (process.platform !== "win32") symlinkSync(dependencies, destination, "junction");
  else {
    mkdirSync(destination);
    const link = (source, target) => {
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
async function subprocessCoverage(directory, root, reportTiming) {
  const phase = phaseTimings(reportTiming);
  root = realpathSync.native(root);
  const bundles = /* @__PURE__ */ new Map();
  const helpers = /* @__PURE__ */ new Map();
  const sources = (directory2) => {
    if (!existsSync(directory2)) return [];
    return readdirSync(directory2, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory2, entry.name);
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
    const map2 = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const url = pathToFileURL(path).href;
    const key = mapIdentity(map2, url);
    const included = /* @__PURE__ */ new Set();
    const mapped = {
      ...map2,
      sources: map2.sources.map((source, index) => {
        const sourcePath = resolve(dirname(path), map2.sourceRoot ?? "", source ?? "");
        if (["src", "scripts", "bin"].some((name) => sourcePath.startsWith(join(root, name) + sep))) {
          if (!existsSync(sourcePath) || readFileSync(sourcePath, "utf8") !== map2.sourcesContent?.[index])
            throw new Error(`${sourcePath}: emitted source differs from the checkout`);
          included.add(sourcePath);
        }
        return relative(dirname(path), sourcePath).split(sep).join("/");
      })
    };
    const candidates2 = bundles.get(key) ?? [];
    candidates2.push({
      code,
      map: mapped,
      included,
      url,
      executions: [],
      sourceType: path.endsWith(".cjs") ? "script" : "module"
    });
    bundles.set(key, candidates2);
  }
  phase(
    "sourceMaps",
    [...bundles.values()].reduce((count, candidates2) => count + candidates2.length, 0)
  );
  const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const concurrency = Math.min(4, cpuBudget());
  const candidates = [...bundles.values()].flat();
  const workers = Math.min(concurrency, Math.ceil(files.length / 16));
  const scans = workers > 1 ? await coverageJobs(
    Array.from({ length: workers }, (_, index) => ({
      kind: "scan",
      directory,
      root,
      candidates,
      files: files.filter((_2, position) => position % workers === index)
    })),
    workers
  ) : [scanCoverageReports(directory, root, candidates, files)];
  const byURL = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  for (const scan of scans) {
    for (const result of scan.bundles) {
      const candidate = required(byURL.get(result.url), "Unknown measured bundle");
      if (workers > 1)
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
  }
  phase("subprocessReports", files.length);
  const measured = [...candidates, ...helpers.values()].filter((script) => script.executions.length);
  const converted = concurrency > 1 && measured.length > 1 ? await coverageJobs(
    measured.map((script) => ({ kind: "convert", script })),
    concurrency
  ) : await Promise.all(measured.map(convertCoverageScript));
  const map = coverage.createCoverageMap({});
  for (const result of converted) map.merge(result);
  phase("subprocessConversion", measured.length);
  return map;
}
function mergeCoverage(paths, directory, thresholds, sourceRoot = process.cwd(), reportRoot = sourceRoot, present) {
  const map = coverage.createCoverageMap({});
  for (const path of paths) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const remapped = sourceRoot === reportRoot ? data : Object.fromEntries(
      Object.entries(data).map(([file, value]) => {
        const absolute = resolve(file);
        if (!absolute.startsWith(sourceRoot + sep)) throw new Error(`coverage path outside workspace: ${file}`);
        const canonical = join(reportRoot, relative(sourceRoot, absolute));
        return [canonical, { ...value, path: canonical }];
      })
    );
    map.merge(remapped);
  }
  const context = report.createContext({ dir: directory, coverageMap: map });
  for (const name of ["text", "json-summary", "json"]) reports.create(name).execute(context);
  present?.(map);
  const summary = map.getCoverageSummary();
  if (!summary.lines.total || !summary.functions.total)
    throw new Error("coverage contains no measured lines or functions");
  for (const metric of ["lines", "functions", "branches", "statements"]) {
    const minimum = thresholds[metric];
    const percentage = summary[metric].pct;
    if (minimum !== void 0 && (typeof percentage !== "number" || percentage < minimum))
      throw new Error(`${metric} coverage ${String(percentage)}% is below ${String(minimum)}%`);
  }
  return map;
}
async function runCoverage(root, builds = join(root, "build")) {
  const started = performance.now();
  const timings = { version: 1, totalMs: 0, phases: {} };
  const reportTiming = (phase2, milliseconds, count) => {
    timings.phases[phase2] = { milliseconds, ...count === void 0 ? {} : { count } };
    console.error(`Coverage ${phase2}: ${(milliseconds / 1e3).toFixed(2)}s`);
  };
  const phase = phaseTimings(reportTiming);
  root = realpathSync.native(root);
  const output = join(root, "coverage");
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error("coverage must be a real directory");
  mkdirSync(output, { recursive: true });
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
    const revision = process.env.WORKBENCH_SOURCE_REVISION ?? (source.status === 0 ? source.stdout.trim() : void 0);
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
          ...revision === void 0 ? {} : { WORKBENCH_SOURCE_REVISION: revision }
        }
      }
    );
    const resultsPath = join(workspace, "coverage/tests.json");
    if (existsSync(resultsPath)) {
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      delete results.coverageMap;
      const remap = (value) => {
        if (typeof value === "string")
          return value.replaceAll(workspace + sep, resolve(root) + sep).replaceAll(workspace.replaceAll(sep, "/") + "/", resolve(root).replaceAll(sep, "/") + "/");
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
    const policy = JSON.parse(readFileSync(join(root, "workbench/quality.json"), "utf8")).coverage;
    const map = mergeCoverage(
      [join(unit, "coverage-final.json"), cli],
      output,
      Object.fromEntries(["lines", "functions", "branches", "statements"].map((key) => [key, policy[key]])),
      workspace,
      resolve(root),
      (map2) => reportCoverageChange(map2, resolve(root), join(output, "coverage-summary.json"))
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
    const cleanupStarted = performance.now();
    rmSync(temporary, { recursive: true, force: true });
    reportTiming("cleanup", performance.now() - cleanupStarted);
    timings.totalMs = performance.now() - started;
    try {
      writeFileSync(join(output, "timings.json"), JSON.stringify(timings, null, 2) + "\n");
    } catch {
      console.error("Coverage timings could not be written.");
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runCoverage(process.cwd(), process.env.WORKBENCH_BUILD_DIR);
export {
  coverageWorkspace,
  mergeCoverage,
  runCoverage,
  subprocessCoverage
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInRlc3QtY292ZXJhZ2UubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIGxzdGF0U3luYyxcbiAgbWtkaXJTeW5jLFxuICBta2R0ZW1wU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICBybVN5bmMsXG4gIHN0YXRTeW5jLFxuICBzeW1saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoLCBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgY292ZXJhZ2UgZnJvbSBcImlzdGFuYnVsLWxpYi1jb3ZlcmFnZVwiO1xuaW1wb3J0IHJlcG9ydCBmcm9tIFwiaXN0YW5idWwtbGliLXJlcG9ydFwiO1xuaW1wb3J0IHJlcG9ydHMgZnJvbSBcImlzdGFuYnVsLXJlcG9ydHNcIjtcbmltcG9ydCB7IGJ1aWxkIH0gZnJvbSBcImVzYnVpbGRcIjtcbmltcG9ydCB7IGNvcHlTb3VyY2VDaGVja291dCB9IGZyb20gXCIuL3NvdXJjZS1jaGVja291dC5tanNcIjtcbmltcG9ydCB7IGJ1bmRsZU9wdGlvbnMgfSBmcm9tIFwiLi9idW5kbGUtb3B0aW9ucy5tanNcIjtcbmltcG9ydCB7IEludmFsaWROb2RlQ292ZXJhZ2VSZXBvcnQsIHR5cGUgQ292ZXJhZ2VTb3VyY2VNYXAgfSBmcm9tIFwiLi9ub2RlLWNvdmVyYWdlLXJlcG9ydHMubWpzXCI7XG5pbXBvcnQgeyBjb3ZlcmFnZVJlcG9zaXRvcnksIHJlcG9ydENvdmVyYWdlQ2hhbmdlLCB0eXBlIE1ldHJpY05hbWUgfSBmcm9tIFwiLi9jb3ZlcmFnZS1zdW1tYXJ5Lm1qc1wiO1xuXG5pbXBvcnQgdHlwZSB7IENvdmVyYWdlTWFwLCBGaWxlQ292ZXJhZ2VEYXRhIH0gZnJvbSBcImlzdGFuYnVsLWxpYi1jb3ZlcmFnZVwiO1xuaW1wb3J0IHsgcmVxdWlyZWQgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5cbmltcG9ydCB7XG4gIG1hcElkZW50aXR5LFxuICBzY2FuQ292ZXJhZ2VSZXBvcnRzLFxuICBjb252ZXJ0Q292ZXJhZ2VTY3JpcHQsXG4gIHJlY29yZEV4ZWN1dGlvbixcbiAgdHlwZSBNZWFzdXJlZFNjcmlwdCxcbn0gZnJvbSBcIi4vY292ZXJhZ2UtcHJvY2Vzc2luZy5tanNcIjtcbmltcG9ydCB7IGNvdmVyYWdlSm9icyB9IGZyb20gXCIuL2NvdmVyYWdlLXdvcmtlcnMubWpzXCI7XG5pbXBvcnQgeyBjcHVCdWRnZXQgfSBmcm9tIFwiLi9jcHUtYnVkZ2V0Lm1qc1wiO1xuXG50eXBlIENvdmVyYWdlUGhhc2UgPVxuICB8IFwid29ya3NwYWNlXCJcbiAgfCBcInRlc3RzXCJcbiAgfCBcInNvdXJjZU1hcHNcIlxuICB8IFwic3VicHJvY2Vzc1JlcG9ydHNcIlxuICB8IFwic3VicHJvY2Vzc0NvbnZlcnNpb25cIlxuICB8IFwic3VicHJvY2Vzc1wiXG4gIHwgXCJyZXBvcnRpbmdcIlxuICB8IFwiY2xlYW51cFwiO1xudHlwZSBDb3ZlcmFnZVRpbWluZyA9IChwaGFzZTogQ292ZXJhZ2VQaGFzZSwgbWlsbGlzZWNvbmRzOiBudW1iZXIsIGNvdW50PzogbnVtYmVyKSA9PiB2b2lkO1xuXG5leHBvcnQgaW50ZXJmYWNlIENvdmVyYWdlVGltaW5ncyB7XG4gIHZlcnNpb246IDE7XG4gIHRvdGFsTXM6IG51bWJlcjtcbiAgcGhhc2VzOiBQYXJ0aWFsPFJlY29yZDxDb3ZlcmFnZVBoYXNlLCB7IG1pbGxpc2Vjb25kczogbnVtYmVyOyBjb3VudD86IG51bWJlciB9Pj47XG59XG5cbmZ1bmN0aW9uIHBoYXNlVGltaW5ncyhyZXBvcnQ/OiBDb3ZlcmFnZVRpbWluZykge1xuICBsZXQgc3RhcnRlZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICByZXR1cm4gKHBoYXNlOiBDb3ZlcmFnZVBoYXNlLCBjb3VudD86IG51bWJlcikgPT4ge1xuICAgIGNvbnN0IG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIHJlcG9ydD8uKHBoYXNlLCBub3cgLSBzdGFydGVkLCBjb3VudCk7XG4gICAgc3RhcnRlZCA9IG5vdztcbiAgfTtcbn1cblxuLy8gSW50ZWdyYXRpb24gdGVzdHMgbGF1bmNoIGFuZCBjb3B5IHRoZSBkaXN0cmlidXRpb24gYmVzaWRlIHRoZWlyIHRlc3Qgc291cmNlcy5cbi8vIEdpdmUgY292ZXJhZ2UgaXRzIG93biBkaXN0cmlidXRpb24gd2l0aG91dCBjaGFuZ2luZyB0aGUgcnVubmFibGUgY2hlY2tvdXQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY292ZXJhZ2VXb3Jrc3BhY2Uocm9vdDogc3RyaW5nLCB0ZW1wb3Jhcnk6IHN0cmluZykge1xuICBpZiAoIVtcIm1haW5cIiwgXCJza2lsbHNcIl0uZXZlcnkoKG5hbWUpID0+IGV4aXN0c1N5bmMoam9pbihyb290LCBgc3JjLyR7bmFtZX0udHNgKSkpKSByZXR1cm4gcm9vdDtcbiAgY29uc3Qgd29ya3NwYWNlID0gam9pbih0ZW1wb3JhcnksIFwicHJvamVjdFwiKTtcbiAgbWtkaXJTeW5jKHdvcmtzcGFjZSk7XG4gIGNvcHlTb3VyY2VDaGVja291dChyb290LCB3b3Jrc3BhY2UpO1xuICAvLyBSZXVzZSBpbnN0YWxsZWQgYnVpbGQvdGVzdCBkZXBlbmRlbmNpZXM7IG5ldmVyIGNvcHkgb3IgZG93bmxvYWQgdGhlbSBmb3IgY292ZXJhZ2UuXG4gIGNvbnN0IGRlcGVuZGVuY2llcyA9IHJlYWxwYXRoU3luYy5uYXRpdmUoam9pbihyb290LCBcIm5vZGVfbW9kdWxlc1wiKSk7XG4gIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbih3b3Jrc3BhY2UsIFwibm9kZV9tb2R1bGVzXCIpO1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKSBzeW1saW5rU3luYyhkZXBlbmRlbmNpZXMsIGRlc3RpbmF0aW9uLCBcImp1bmN0aW9uXCIpO1xuICBlbHNlIHtcbiAgICAvLyBSZXNvbHZlIHBhY2thZ2UgdGFyZ2V0cyBiZWZvcmUgY3Jvc3NpbmcgZHJpdmVzOiBwbnBtJ3MgcmVsYXRpdmUgcGFja2FnZSBsaW5rc1xuICAgIC8vIG11c3QgcmV0YWluIHRoZWlyIG9yaWdpbmFsIHZpcnR1YWwtc3RvcmUgYmFzZSB0aHJvdWdoIHRoZSBkaXNwb3NhYmxlIHdvcmtzcGFjZS5cbiAgICBta2RpclN5bmMoZGVzdGluYXRpb24pO1xuICAgIGNvbnN0IGxpbmsgPSAoc291cmNlOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBjYW5vbmljYWwgPSByZWFscGF0aFN5bmMubmF0aXZlKHNvdXJjZSk7XG4gICAgICBzeW1saW5rU3luYyhjYW5vbmljYWwsIHRhcmdldCwgc3RhdFN5bmMoY2Fub25pY2FsKS5pc0RpcmVjdG9yeSgpID8gXCJqdW5jdGlvblwiIDogXCJmaWxlXCIpO1xuICAgIH07XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhkZXBlbmRlbmNpZXMpKSB7XG4gICAgICBjb25zdCBzb3VyY2UgPSBqb2luKGRlcGVuZGVuY2llcywgZW50cnkpO1xuICAgICAgY29uc3QgdGFyZ2V0ID0gam9pbihkZXN0aW5hdGlvbiwgZW50cnkpO1xuICAgICAgaWYgKCFlbnRyeS5zdGFydHNXaXRoKFwiQFwiKSkgbGluayhzb3VyY2UsIHRhcmdldCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgbWtkaXJTeW5jKHRhcmdldCk7XG4gICAgICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhzb3VyY2UpKSBsaW5rKGpvaW4oc291cmNlLCBuYW1lKSwgam9pbih0YXJnZXQsIG5hbWUpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcIm1haW5cIiwgXCJza2lsbHNcIiwgXCJwYWNrYWdlXCIsIFwibGF1bmNoZXJcIiwgXCJib290c3RyYXBcIl0pXG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbih3b3Jrc3BhY2UsIGBzcmMvJHtuYW1lfS50c2ApKSkgYXdhaXQgYnVpbGQoYnVuZGxlT3B0aW9ucyh3b3Jrc3BhY2UsIG5hbWUsIHRydWUpKTtcbiAgcmV0dXJuIHdvcmtzcGFjZTtcbn1cblxuLy8gVXNlIHRoZSBzYW1lIEFTVC1hd2FyZSBjb252ZXJzaW9uIGFzIFZpdGVzdC4gTWF0Y2ggZnVsbCBtYXAgY29udGVudHMgYmVmb3JlIGF0dHJpYnV0aW5nIGEgY29waWVkIGJ1bmRsZS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdWJwcm9jZXNzQ292ZXJhZ2UoZGlyZWN0b3J5OiBzdHJpbmcsIHJvb3Q6IHN0cmluZywgcmVwb3J0VGltaW5nPzogQ292ZXJhZ2VUaW1pbmcpIHtcbiAgY29uc3QgcGhhc2UgPSBwaGFzZVRpbWluZ3MocmVwb3J0VGltaW5nKTtcbiAgLy8gTm9kZSByZWNvcmRzIGNhbm9uaWNhbCBmaWxlIFVSTHMsIGluY2x1ZGluZyBtYWNPUydzIC92YXIgLT4gL3ByaXZhdGUvdmFyIHRlbXBvcmFyeSByb290cy5cbiAgcm9vdCA9IHJlYWxwYXRoU3luYy5uYXRpdmUocm9vdCk7XG4gIGNvbnN0IGJ1bmRsZXMgPSBuZXcgTWFwPHN0cmluZywgTWVhc3VyZWRTY3JpcHRbXT4oKTtcbiAgY29uc3QgaGVscGVycyA9IG5ldyBNYXA8c3RyaW5nLCBNZWFzdXJlZFNjcmlwdD4oKTtcbiAgY29uc3Qgc291cmNlcyA9IChkaXJlY3Rvcnk6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoZGlyZWN0b3J5KSkgcmV0dXJuIFtdO1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KS5mbGF0TWFwKChlbnRyeSkgPT4ge1xuICAgICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKTtcbiAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSByZXR1cm4gc291cmNlcyhwYXRoKTtcbiAgICAgIHJldHVybiBlbnRyeS5pc0ZpbGUoKSAmJiAvXFwuKD86bWpzfGNqc3xqcykkLy50ZXN0KGVudHJ5Lm5hbWUpID8gW3BhdGhdIDogW107XG4gICAgfSk7XG4gIH07XG4gIGZvciAoY29uc3QgcGF0aCBvZiBbXCJidW5kbGVcIiwgXCJzY3JpcHRzXCIsIFwiYmluXCJdLmZsYXRNYXAoKG5hbWUpID0+IHNvdXJjZXMoam9pbihyb290LCBuYW1lKSkpKSB7XG4gICAgY29uc3QgY29kZSA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgY29uc3QgZW5jb2RlZCA9IC9zb3VyY2VNYXBwaW5nVVJMPWRhdGE6YXBwbGljYXRpb25cXC9qc29uKD86O2NoYXJzZXQ9dXRmLTgpPztiYXNlNjQsKFteXFxzXSspLy5leGVjKGNvZGUpPy5bMV07XG4gICAgaWYgKCFlbmNvZGVkKSB7XG4gICAgICBpZiAoZGlybmFtZShwYXRoKSA9PT0gam9pbihyb290LCBcImJ1bmRsZVwiKSAmJiBwYXRoLmVuZHNXaXRoKFwiLmNqc1wiKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3BhdGh9OiBidW5kbGUgbmVlZHMgYW4gaW5saW5lIHNvdXJjZSBtYXBgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBtYXAgPSBKU09OLnBhcnNlKEJ1ZmZlci5mcm9tKGVuY29kZWQsIFwiYmFzZTY0XCIpLnRvU3RyaW5nKFwidXRmOFwiKSkgYXMgQ292ZXJhZ2VTb3VyY2VNYXA7XG4gICAgY29uc3QgdXJsID0gcGF0aFRvRmlsZVVSTChwYXRoKS5ocmVmO1xuICAgIGNvbnN0IGtleSA9IG1hcElkZW50aXR5KG1hcCwgdXJsKTtcbiAgICBjb25zdCBpbmNsdWRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGNvbnN0IG1hcHBlZCA9IHtcbiAgICAgIC4uLm1hcCxcbiAgICAgIHNvdXJjZXM6IG1hcC5zb3VyY2VzLm1hcCgoc291cmNlLCBpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBzb3VyY2VQYXRoID0gcmVzb2x2ZShkaXJuYW1lKHBhdGgpLCBtYXAuc291cmNlUm9vdCA/PyBcIlwiLCBzb3VyY2UgPz8gXCJcIik7XG4gICAgICAgIGlmIChbXCJzcmNcIiwgXCJzY3JpcHRzXCIsIFwiYmluXCJdLnNvbWUoKG5hbWUpID0+IHNvdXJjZVBhdGguc3RhcnRzV2l0aChqb2luKHJvb3QsIG5hbWUpICsgc2VwKSkpIHtcbiAgICAgICAgICBpZiAoIWV4aXN0c1N5bmMoc291cmNlUGF0aCkgfHwgcmVhZEZpbGVTeW5jKHNvdXJjZVBhdGgsIFwidXRmOFwiKSAhPT0gbWFwLnNvdXJjZXNDb250ZW50Py5baW5kZXhdKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3NvdXJjZVBhdGh9OiBlbWl0dGVkIHNvdXJjZSBkaWZmZXJzIGZyb20gdGhlIGNoZWNrb3V0YCk7XG4gICAgICAgICAgaW5jbHVkZWQuYWRkKHNvdXJjZVBhdGgpO1xuICAgICAgICB9XG4gICAgICAgIC8vIFJlbGF0aXZlIFVSTHMgYXZvaWQgdHJlYXRpbmcgV2luZG93cyBkcml2ZSBsZXR0ZXJzIGFzIFVSSSBzY2hlbWVzLlxuICAgICAgICByZXR1cm4gcmVsYXRpdmUoZGlybmFtZShwYXRoKSwgc291cmNlUGF0aCkuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcbiAgICAgIH0pLFxuICAgIH07XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IGJ1bmRsZXMuZ2V0KGtleSkgPz8gW107XG4gICAgY2FuZGlkYXRlcy5wdXNoKHtcbiAgICAgIGNvZGUsXG4gICAgICBtYXA6IG1hcHBlZCxcbiAgICAgIGluY2x1ZGVkLFxuICAgICAgdXJsLFxuICAgICAgZXhlY3V0aW9uczogW10sXG4gICAgICBzb3VyY2VUeXBlOiBwYXRoLmVuZHNXaXRoKFwiLmNqc1wiKSA/IFwic2NyaXB0XCIgOiBcIm1vZHVsZVwiLFxuICAgIH0pO1xuICAgIGJ1bmRsZXMuc2V0KGtleSwgY2FuZGlkYXRlcyk7XG4gIH1cbiAgcGhhc2UoXG4gICAgXCJzb3VyY2VNYXBzXCIsXG4gICAgWy4uLmJ1bmRsZXMudmFsdWVzKCldLnJlZHVjZSgoY291bnQsIGNhbmRpZGF0ZXMpID0+IGNvdW50ICsgY2FuZGlkYXRlcy5sZW5ndGgsIDApLFxuICApO1xuICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGRpcmVjdG9yeSlcbiAgICAuZmlsdGVyKChuYW1lKSA9PiBuYW1lLmVuZHNXaXRoKFwiLmpzb25cIikpXG4gICAgLnNvcnQoKTtcbiAgY29uc3QgY29uY3VycmVuY3kgPSBNYXRoLm1pbig0LCBjcHVCdWRnZXQoKSk7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBbLi4uYnVuZGxlcy52YWx1ZXMoKV0uZmxhdCgpO1xuICBjb25zdCB3b3JrZXJzID0gTWF0aC5taW4oY29uY3VycmVuY3ksIE1hdGguY2VpbChmaWxlcy5sZW5ndGggLyAxNikpO1xuICBjb25zdCBzY2FucyA9XG4gICAgd29ya2VycyA+IDFcbiAgICAgID8gYXdhaXQgY292ZXJhZ2VKb2JzKFxuICAgICAgICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IHdvcmtlcnMgfSwgKF8sIGluZGV4KSA9PiAoe1xuICAgICAgICAgICAga2luZDogXCJzY2FuXCIgYXMgY29uc3QsXG4gICAgICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgY2FuZGlkYXRlcyxcbiAgICAgICAgICAgIGZpbGVzOiBmaWxlcy5maWx0ZXIoKF8sIHBvc2l0aW9uKSA9PiBwb3NpdGlvbiAlIHdvcmtlcnMgPT09IGluZGV4KSxcbiAgICAgICAgICB9KSksXG4gICAgICAgICAgd29ya2VycyxcbiAgICAgICAgKVxuICAgICAgOiBbc2NhbkNvdmVyYWdlUmVwb3J0cyhkaXJlY3RvcnksIHJvb3QsIGNhbmRpZGF0ZXMsIGZpbGVzKV07XG4gIGNvbnN0IGJ5VVJMID0gbmV3IE1hcChjYW5kaWRhdGVzLm1hcCgoY2FuZGlkYXRlKSA9PiBbY2FuZGlkYXRlLnVybCwgY2FuZGlkYXRlXSkpO1xuICBmb3IgKGNvbnN0IHNjYW4gb2Ygc2NhbnMpIHtcbiAgICBmb3IgKGNvbnN0IHJlc3VsdCBvZiBzY2FuLmJ1bmRsZXMpIHtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHJlcXVpcmVkKGJ5VVJMLmdldChyZXN1bHQudXJsKSwgXCJVbmtub3duIG1lYXN1cmVkIGJ1bmRsZVwiKTtcbiAgICAgIC8vIERpcmVjdCBzY2FucyBzaGFyZSB0aGVzZSBvYmplY3RzOyB3b3JrZXIgc2NhbnMgcmV0dXJuIGluZGVwZW5kZW50IGFjY3VtdWxhdGVkIHJhbmdlcy5cbiAgICAgIGlmICh3b3JrZXJzID4gMSlcbiAgICAgICAgZm9yIChjb25zdCBleGVjdXRpb24gb2YgcmVzdWx0LmV4ZWN1dGlvbnMpXG4gICAgICAgICAgZm9yIChjb25zdCBzY3JpcHQgb2YgZXhlY3V0aW9uLnJlc3VsdCkgcmVjb3JkRXhlY3V0aW9uKGNhbmRpZGF0ZSwgc2NyaXB0KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygc2Nhbi5oZWxwZXJzKSB7XG4gICAgICBjb25zdCBwcmV2aW91cyA9IGhlbHBlcnMuZ2V0KGhlbHBlci51cmwpO1xuICAgICAgaWYgKCFwcmV2aW91cykgaGVscGVycy5zZXQoaGVscGVyLnVybCwgaGVscGVyKTtcbiAgICAgIGVsc2VcbiAgICAgICAgZm9yIChjb25zdCBleGVjdXRpb24gb2YgaGVscGVyLmV4ZWN1dGlvbnMpXG4gICAgICAgICAgZm9yIChjb25zdCBzY3JpcHQgb2YgZXhlY3V0aW9uLnJlc3VsdCkgcmVjb3JkRXhlY3V0aW9uKHByZXZpb3VzLCBzY3JpcHQpO1xuICAgIH1cbiAgfVxuICBwaGFzZShcInN1YnByb2Nlc3NSZXBvcnRzXCIsIGZpbGVzLmxlbmd0aCk7XG4gIGNvbnN0IG1lYXN1cmVkID0gWy4uLmNhbmRpZGF0ZXMsIC4uLmhlbHBlcnMudmFsdWVzKCldLmZpbHRlcigoc2NyaXB0KSA9PiBzY3JpcHQuZXhlY3V0aW9ucy5sZW5ndGgpO1xuICBjb25zdCBjb252ZXJ0ZWQgPVxuICAgIGNvbmN1cnJlbmN5ID4gMSAmJiBtZWFzdXJlZC5sZW5ndGggPiAxXG4gICAgICA/IGF3YWl0IGNvdmVyYWdlSm9icyhcbiAgICAgICAgICBtZWFzdXJlZC5tYXAoKHNjcmlwdCkgPT4gKHsga2luZDogXCJjb252ZXJ0XCIgYXMgY29uc3QsIHNjcmlwdCB9KSksXG4gICAgICAgICAgY29uY3VycmVuY3ksXG4gICAgICAgIClcbiAgICAgIDogYXdhaXQgUHJvbWlzZS5hbGwobWVhc3VyZWQubWFwKGNvbnZlcnRDb3ZlcmFnZVNjcmlwdCkpO1xuICBjb25zdCBtYXAgPSBjb3ZlcmFnZS5jcmVhdGVDb3ZlcmFnZU1hcCh7fSk7XG4gIGZvciAoY29uc3QgcmVzdWx0IG9mIGNvbnZlcnRlZCkgbWFwLm1lcmdlKHJlc3VsdCk7XG4gIHBoYXNlKFwic3VicHJvY2Vzc0NvbnZlcnNpb25cIiwgbWVhc3VyZWQubGVuZ3RoKTtcbiAgcmV0dXJuIG1hcDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlQ292ZXJhZ2UoXG4gIHBhdGhzOiBzdHJpbmdbXSxcbiAgZGlyZWN0b3J5OiBzdHJpbmcsXG4gIHRocmVzaG9sZHM6IFBhcnRpYWw8UmVjb3JkPE1ldHJpY05hbWUsIG51bWJlcj4+LFxuICBzb3VyY2VSb290ID0gcHJvY2Vzcy5jd2QoKSxcbiAgcmVwb3J0Um9vdCA9IHNvdXJjZVJvb3QsXG4gIHByZXNlbnQ/OiAobWFwOiBDb3ZlcmFnZU1hcCkgPT4gdm9pZCxcbikge1xuICBjb25zdCBtYXAgPSBjb3ZlcmFnZS5jcmVhdGVDb3ZlcmFnZU1hcCh7fSk7XG4gIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIFJlY29yZDxzdHJpbmcsIEZpbGVDb3ZlcmFnZURhdGE+O1xuICAgIGNvbnN0IHJlbWFwcGVkID1cbiAgICAgIHNvdXJjZVJvb3QgPT09IHJlcG9ydFJvb3RcbiAgICAgICAgPyBkYXRhXG4gICAgICAgIDogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoZGF0YSkubWFwKChbZmlsZSwgdmFsdWVdKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IGFic29sdXRlID0gcmVzb2x2ZShmaWxlKTtcbiAgICAgICAgICAgICAgaWYgKCFhYnNvbHV0ZS5zdGFydHNXaXRoKHNvdXJjZVJvb3QgKyBzZXApKSB0aHJvdyBuZXcgRXJyb3IoYGNvdmVyYWdlIHBhdGggb3V0c2lkZSB3b3Jrc3BhY2U6ICR7ZmlsZX1gKTtcbiAgICAgICAgICAgICAgY29uc3QgY2Fub25pY2FsID0gam9pbihyZXBvcnRSb290LCByZWxhdGl2ZShzb3VyY2VSb290LCBhYnNvbHV0ZSkpO1xuICAgICAgICAgICAgICByZXR1cm4gW2Nhbm9uaWNhbCwgeyAuLi52YWx1ZSwgcGF0aDogY2Fub25pY2FsIH1dO1xuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKTtcbiAgICBtYXAubWVyZ2UocmVtYXBwZWQpO1xuICB9XG4gIGNvbnN0IGNvbnRleHQgPSByZXBvcnQuY3JlYXRlQ29udGV4dCh7IGRpcjogZGlyZWN0b3J5LCBjb3ZlcmFnZU1hcDogbWFwIH0pO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1widGV4dFwiLCBcImpzb24tc3VtbWFyeVwiLCBcImpzb25cIl0gYXMgY29uc3QpIHJlcG9ydHMuY3JlYXRlKG5hbWUpLmV4ZWN1dGUoY29udGV4dCk7XG4gIHByZXNlbnQ/LihtYXApO1xuICBjb25zdCBzdW1tYXJ5ID0gbWFwLmdldENvdmVyYWdlU3VtbWFyeSgpO1xuICBpZiAoIXN1bW1hcnkubGluZXMudG90YWwgfHwgIXN1bW1hcnkuZnVuY3Rpb25zLnRvdGFsKVxuICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIGNvbnRhaW5zIG5vIG1lYXN1cmVkIGxpbmVzIG9yIGZ1bmN0aW9uc1wiKTtcbiAgZm9yIChjb25zdCBtZXRyaWMgb2YgW1wibGluZXNcIiwgXCJmdW5jdGlvbnNcIiwgXCJicmFuY2hlc1wiLCBcInN0YXRlbWVudHNcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBtaW5pbXVtID0gdGhyZXNob2xkc1ttZXRyaWNdO1xuICAgIGNvbnN0IHBlcmNlbnRhZ2UgPSBzdW1tYXJ5W21ldHJpY10ucGN0O1xuICAgIGlmIChtaW5pbXVtICE9PSB1bmRlZmluZWQgJiYgKHR5cGVvZiBwZXJjZW50YWdlICE9PSBcIm51bWJlclwiIHx8IHBlcmNlbnRhZ2UgPCBtaW5pbXVtKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHttZXRyaWN9IGNvdmVyYWdlICR7U3RyaW5nKHBlcmNlbnRhZ2UpfSUgaXMgYmVsb3cgJHtTdHJpbmcobWluaW11bSl9JWApO1xuICB9XG4gIHJldHVybiBtYXA7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5Db3ZlcmFnZShyb290OiBzdHJpbmcsIGJ1aWxkcyA9IGpvaW4ocm9vdCwgXCJidWlsZFwiKSkge1xuICBjb25zdCBzdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRpbWluZ3M6IENvdmVyYWdlVGltaW5ncyA9IHsgdmVyc2lvbjogMSwgdG90YWxNczogMCwgcGhhc2VzOiB7fSB9O1xuICBjb25zdCByZXBvcnRUaW1pbmc6IENvdmVyYWdlVGltaW5nID0gKHBoYXNlLCBtaWxsaXNlY29uZHMsIGNvdW50KSA9PiB7XG4gICAgdGltaW5ncy5waGFzZXNbcGhhc2VdID0geyBtaWxsaXNlY29uZHMsIC4uLihjb3VudCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGNvdW50IH0pIH07XG4gICAgY29uc29sZS5lcnJvcihgQ292ZXJhZ2UgJHtwaGFzZX06ICR7KG1pbGxpc2Vjb25kcyAvIDEwMDApLnRvRml4ZWQoMil9c2ApO1xuICB9O1xuICBjb25zdCBwaGFzZSA9IHBoYXNlVGltaW5ncyhyZXBvcnRUaW1pbmcpO1xuICByb290ID0gcmVhbHBhdGhTeW5jLm5hdGl2ZShyb290KTtcbiAgY29uc3Qgb3V0cHV0ID0gam9pbihyb290LCBcImNvdmVyYWdlXCIpO1xuICBpZiAoZXhpc3RzU3luYyhvdXRwdXQpICYmIGxzdGF0U3luYyhvdXRwdXQpLmlzU3ltYm9saWNMaW5rKCkpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIFByZXNlcnZlIHRoZSB0cmFja2VkIGJhc2VsaW5lIGlmIHRlc3QgY29sbGVjdGlvbiBmYWlscyBiZWZvcmUgYSByZXBsYWNlbWVudCBleGlzdHMuXG4gIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhvdXRwdXQpKVxuICAgIGlmIChuYW1lICE9PSBcImNvdmVyYWdlLXN1bW1hcnkuanNvblwiKSBybVN5bmMoam9pbihvdXRwdXQsIG5hbWUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIGNvbnN0IHN1bW1hcnlQYXRoID0gam9pbihvdXRwdXQsIFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpO1xuICBpZiAoZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCkgJiYgbHN0YXRTeW5jKHN1bW1hcnlQYXRoKS5pc1N5bWJvbGljTGluaygpKVxuICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIHN1bW1hcnkgbXVzdCBiZSBhIHJlZ3VsYXIgZmlsZVwiKTtcbiAgbWtkaXJTeW5jKGJ1aWxkcywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4ocmVhbHBhdGhTeW5jLm5hdGl2ZShidWlsZHMpLCBcImNvdmVyYWdlLVwiKSk7XG4gIHRyeSB7XG4gICAgY29uc3Qgd29ya3NwYWNlID0gYXdhaXQgY292ZXJhZ2VXb3Jrc3BhY2UocmVzb2x2ZShyb290KSwgdGVtcG9yYXJ5KTtcbiAgICBwaGFzZShcIndvcmtzcGFjZVwiKTtcbiAgICBjb25zdCBzb3VyY2UgPSBzcGF3blN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgeyBjd2Q6IGNvdmVyYWdlUmVwb3NpdG9yeShyb290KSwgZW5jb2Rpbmc6IFwidXRmOFwiIH0pO1xuICAgIGNvbnN0IHJldmlzaW9uID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NPVVJDRV9SRVZJU0lPTiA/PyAoc291cmNlLnN0YXR1cyA9PT0gMCA/IHNvdXJjZS5zdGRvdXQudHJpbSgpIDogdW5kZWZpbmVkKTtcbiAgICBjb25zdCByYXcgPSBqb2luKHRlbXBvcmFyeSwgXCJyYXdcIik7XG4gICAgY29uc3QgdW5pdCA9IGpvaW4odGVtcG9yYXJ5LCBcInVuaXRcIik7XG4gICAgY29uc3QgdGVzdHMgPSBzcGF3blN5bmMoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1wibm9kZV9tb2R1bGVzL3ZpdGVzdC92aXRlc3QubWpzXCIsIFwicnVuXCIsIFwiLS1jb3ZlcmFnZVwiLCBcIi0tY292ZXJhZ2UucmVwb3J0c0RpcmVjdG9yeVwiLCB1bml0XSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiB3b3Jrc3BhY2UsXG4gICAgICAgIHN0ZGlvOiBcImluaGVyaXRcIixcbiAgICAgICAgLy8gVml0ZXN0IGFscmVhZHkgbWVhc3VyZXMgaXRzIHdvcmtlcnMuIFRoZWlyIHNldHVwIGVuYWJsZXMgbmF0aXZlIFY4IGNhcHR1cmUgb25seSBmb3IgQ0xJIGNoaWxkcmVuLlxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBOT0RFX1Y4X0NPVkVSQUdFOiBcIlwiLFxuICAgICAgICAgIFdPUktCRU5DSF9TVUJQUk9DRVNTX0NPVkVSQUdFOiByYXcsXG4gICAgICAgICAgLi4uKHJldmlzaW9uID09PSB1bmRlZmluZWQgPyB7fSA6IHsgV09SS0JFTkNIX1NPVVJDRV9SRVZJU0lPTjogcmV2aXNpb24gfSksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0c1BhdGggPSBqb2luKHdvcmtzcGFjZSwgXCJjb3ZlcmFnZS90ZXN0cy5qc29uXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKHJlc3VsdHNQYXRoKSkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlc3VsdHNQYXRoLCBcInV0ZjhcIikpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgLy8gRGVkaWNhdGVkIGNvdmVyYWdlIHJlcG9ydHMgcmV0YWluIHRoZSBtYXA7IHRlc3QgZXZpZGVuY2UgcmV0YWlucyBvdXRjb21lcywgZGlhZ25vc3RpY3MsIGFuZCB0aW1pbmdzLlxuICAgICAgZGVsZXRlIHJlc3VsdHMuY292ZXJhZ2VNYXA7XG4gICAgICBjb25zdCByZW1hcCA9ICh2YWx1ZTogdW5rbm93bik6IHVua25vd24gPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKVxuICAgICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgICAgICAgLnJlcGxhY2VBbGwod29ya3NwYWNlICsgc2VwLCByZXNvbHZlKHJvb3QpICsgc2VwKVxuICAgICAgICAgICAgLnJlcGxhY2VBbGwod29ya3NwYWNlLnJlcGxhY2VBbGwoc2VwLCBcIi9cIikgKyBcIi9cIiwgcmVzb2x2ZShyb290KS5yZXBsYWNlQWxsKHNlcCwgXCIvXCIpICsgXCIvXCIpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5tYXAocmVtYXApO1xuICAgICAgICBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiKVxuICAgICAgICAgIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXModmFsdWUpLm1hcCgoW2tleSwgZW50cnldKSA9PiBba2V5LCByZW1hcChlbnRyeSldKSk7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH07XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcInRlc3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHJlbWFwKHJlc3VsdHMpKSk7XG4gICAgfVxuICAgIHBoYXNlKFwidGVzdHNcIik7XG4gICAgaWYgKHRlc3RzLmVycm9yIHx8IHRlc3RzLnN0YXR1cyAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKFwidGVzdHMgb3IgY292ZXJhZ2UgY29sbGVjdGlvbiBmYWlsZWRcIik7XG4gICAgY29uc3QgY2xpID0gam9pbih0ZW1wb3JhcnksIFwiY2xpLmpzb25cIik7XG4gICAgd3JpdGVGaWxlU3luYyhjbGksIEpTT04uc3RyaW5naWZ5KGF3YWl0IHN1YnByb2Nlc3NDb3ZlcmFnZShyYXcsIHdvcmtzcGFjZSwgcmVwb3J0VGltaW5nKSkpO1xuICAgIHBoYXNlKFwic3VicHJvY2Vzc1wiKTtcbiAgICBjb25zdCBwb2xpY3kgPSAoXG4gICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwid29ya2JlbmNoL3F1YWxpdHkuanNvblwiKSwgXCJ1dGY4XCIpKSBhcyB7IGNvdmVyYWdlOiBSZWNvcmQ8TWV0cmljTmFtZSwgbnVtYmVyPiB9XG4gICAgKS5jb3ZlcmFnZTtcbiAgICBjb25zdCBtYXAgPSBtZXJnZUNvdmVyYWdlKFxuICAgICAgW2pvaW4odW5pdCwgXCJjb3ZlcmFnZS1maW5hbC5qc29uXCIpLCBjbGldLFxuICAgICAgb3V0cHV0LFxuICAgICAgT2JqZWN0LmZyb21FbnRyaWVzKChbXCJsaW5lc1wiLCBcImZ1bmN0aW9uc1wiLCBcImJyYW5jaGVzXCIsIFwic3RhdGVtZW50c1wiXSBhcyBjb25zdCkubWFwKChrZXkpID0+IFtrZXksIHBvbGljeVtrZXldXSkpLFxuICAgICAgd29ya3NwYWNlLFxuICAgICAgcmVzb2x2ZShyb290KSxcbiAgICAgIChtYXA6IGNvdmVyYWdlLkNvdmVyYWdlTWFwKSA9PiByZXBvcnRDb3ZlcmFnZUNoYW5nZShtYXAsIHJlc29sdmUocm9vdCksIGpvaW4ob3V0cHV0LCBcImNvdmVyYWdlLXN1bW1hcnkuanNvblwiKSksXG4gICAgKTtcbiAgICBwaGFzZShcInJlcG9ydGluZ1wiKTtcbiAgICByZXR1cm4gbWFwO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEludmFsaWROb2RlQ292ZXJhZ2VSZXBvcnQpIHtcbiAgICAgIGNvbnN0IGRpYWdub3N0aWMgPSBqb2luKG91dHB1dCwgXCJjb2xsZWN0aW9uLWVycm9yLmpzb25cIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGRpYWdub3N0aWMsIEpTT04uc3RyaW5naWZ5KGVycm9yLmRpYWdub3N0aWMsIG51bGwsIDIpICsgXCJcXG5cIik7XG4gICAgICBjb25zb2xlLmVycm9yKGBDb3ZlcmFnZSBjb2xsZWN0aW9uIGRpYWdub3N0aWNzOiAke2RpYWdub3N0aWN9YCk7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9IGZpbmFsbHkge1xuICAgIC8vIFJhdyBWOCBvdXRwdXQgY29udGFpbnMgcmVwZWF0ZWQgc291cmNlIG1hcHMgYW5kIGNhbiBkd2FyZiB0aGUgZmluYWwgcmVwb3J0cy5cbiAgICBjb25zdCBjbGVhbnVwU3RhcnRlZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICByZXBvcnRUaW1pbmcoXCJjbGVhbnVwXCIsIHBlcmZvcm1hbmNlLm5vdygpIC0gY2xlYW51cFN0YXJ0ZWQpO1xuICAgIHRpbWluZ3MudG90YWxNcyA9IHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnRlZDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG91dHB1dCwgXCJ0aW1pbmdzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHRpbWluZ3MsIG51bGwsIDIpICsgXCJcXG5cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBPYnNlcnZhdGlvbmFsIHRpbWluZyBvdXRwdXQgbXVzdCBub3QgcmVwbGFjZSBhIHRlc3Qgb3IgY29sbGVjdGlvbiBmYWlsdXJlLlxuICAgICAgY29uc29sZS5lcnJvcihcIkNvdmVyYWdlIHRpbWluZ3MgY291bGQgbm90IGJlIHdyaXR0ZW4uXCIpO1xuICAgIH1cbiAgfVxufVxuXG5pZiAocHJvY2Vzcy5hcmd2WzFdICYmIHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSA9PT0gZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKVxuICBhd2FpdCBydW5Db3ZlcmFnZShwcm9jZXNzLmN3ZCgpLCBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSKTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsaUJBQWlCO0FBQzFCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDdEQsU0FBUyxlQUFlLHFCQUFxQjtBQUM3QyxPQUFPLGNBQWM7QUFDckIsT0FBTyxZQUFZO0FBQ25CLE9BQU8sYUFBYTtBQUNwQixTQUFTLGFBQWE7QUFDdEIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxpQ0FBeUQ7QUFDbEUsU0FBUyxvQkFBb0IsNEJBQTZDO0FBRzFFLFNBQVMsZ0JBQWdCO0FBRXpCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUCxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGlCQUFpQjtBQW1CMUIsU0FBUyxhQUFhQSxTQUF5QjtBQUM3QyxNQUFJLFVBQVUsWUFBWSxJQUFJO0FBQzlCLFNBQU8s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QUMsQ0FBQztBQUN6RixVQUFNLFlBQVk7QUFDbEIsVUFBTSxTQUNKLEtBQUssTUFBTSxhQUFhLEtBQUssTUFBTSx3QkFBd0IsR0FBRyxNQUFNLENBQUMsRUFDckU7QUFDRixVQUFNLE1BQU07QUFBQSxNQUNWLENBQUMsS0FBSyxNQUFNLHFCQUFxQixHQUFHLEdBQUc7QUFBQSxNQUN2QztBQUFBLE1BQ0EsT0FBTyxZQUFhLENBQUMsU0FBUyxhQUFhLFlBQVksWUFBWSxFQUFZLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFBQSxNQUMvRztBQUFBLE1BQ0EsUUFBUSxJQUFJO0FBQUEsTUFDWixDQUFDSCxTQUE4QixxQkFBcUJBLE1BQUssUUFBUSxJQUFJLEdBQUcsS0FBSyxRQUFRLHVCQUF1QixDQUFDO0FBQUEsSUFDL0c7QUFDQSxVQUFNLFdBQVc7QUFDakIsV0FBTztBQUFBLEVBQ1QsU0FBUyxPQUFPO0FBQ2QsUUFBSSxpQkFBaUIsMkJBQTJCO0FBQzlDLFlBQU0sYUFBYSxLQUFLLFFBQVEsdUJBQXVCO0FBQ3ZELG9CQUFjLFlBQVksS0FBSyxVQUFVLE1BQU0sWUFBWSxNQUFNLENBQUMsSUFBSSxJQUFJO0FBQzFFLGNBQVEsTUFBTSxvQ0FBb0MsVUFBVSxFQUFFO0FBQUEsSUFDaEU7QUFDQSxVQUFNO0FBQUEsRUFDUixVQUFFO0FBRUEsVUFBTSxpQkFBaUIsWUFBWSxJQUFJO0FBQ3ZDLFdBQU8sV0FBVyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUNsRCxpQkFBYSxXQUFXLFlBQVksSUFBSSxJQUFJLGNBQWM7QUFDMUQsWUFBUSxVQUFVLFlBQVksSUFBSSxJQUFJO0FBQ3RDLFFBQUk7QUFDRixvQkFBYyxLQUFLLFFBQVEsY0FBYyxHQUFHLEtBQUssVUFBVSxTQUFTLE1BQU0sQ0FBQyxJQUFJLElBQUk7QUFBQSxJQUNyRixRQUFRO0FBRU4sY0FBUSxNQUFNLHdDQUF3QztBQUFBLElBQ3hEO0FBQUEsRUFDRjtBQUNGO0FBRUEsSUFBSSxRQUFRLEtBQUssQ0FBQyxLQUFLLFFBQVEsUUFBUSxLQUFLLENBQUMsQ0FBQyxNQUFNLGNBQWMsWUFBWSxHQUFHO0FBQy9FLFFBQU0sWUFBWSxRQUFRLElBQUksR0FBRyxRQUFRLElBQUksbUJBQW1COyIsIm5hbWVzIjpbInJlcG9ydCIsImRpcmVjdG9yeSIsIm1hcCIsImNhbmRpZGF0ZXMiLCJfIiwicGhhc2UiXSwiZmlsZSI6InNjcmlwdHMvdGVzdC1jb3ZlcmFnZS5tanMifQ==
