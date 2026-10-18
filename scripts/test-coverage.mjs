// Generated from test-coverage.mts; edit the TypeScript source.
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
import {
  InvalidNodeCoverageReport,
  readNodeCoverageReports
} from "./node-coverage-reports.mjs";
import { coverageRepository, reportCoverageChange } from "./coverage-summary.mjs";
import { required } from "./values.mjs";
function recordExecution(measured, script) {
  measured.executions.push({
    result: [{ ...script, scriptId: script.scriptId ?? script.url, url: measured.url }]
  });
  if (measured.executions.length === 32) measured.executions = [mergeProcessCovs(measured.executions)];
}
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
  const identity = (map2, url) => JSON.stringify(
    map2.file ?? map2.sources.map((source) => {
      const directory2 = dirname(fileURLToPath(url));
      const path = source?.startsWith("file:") ? fileURLToPath(source) : resolve(directory2, map2.sourceRoot ?? "", source ?? "");
      return relative(directory2, path).split(sep).join("/");
    })
  );
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
    const key = identity(map2, url);
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
    const candidates = bundles.get(key) ?? [];
    candidates.push({
      code,
      map: mapped,
      included,
      url,
      executions: [],
      sourceType: path.endsWith(".cjs") ? "script" : "module"
    });
    bundles.set(key, candidates);
  }
  phase(
    "sourceMaps",
    [...bundles.values()].reduce((count, candidates) => count + candidates.length, 0)
  );
  let reportCount = 0;
  for (const data of readNodeCoverageReports(directory)) {
    reportCount++;
    for (const script of data.result) {
      const map2 = data["source-map-cache"]?.[script.url]?.data;
      if (map2) {
        if (!script.url.startsWith("file:")) continue;
        const candidates = (bundles.get(identity(map2, script.url)) ?? []).filter(
          (candidate) => map2.mappings === candidate.map?.mappings && isDeepStrictEqual(map2.names, candidate.map.names) && isDeepStrictEqual(map2.sourcesContent, candidate.map.sourcesContent)
        );
        const bundle = candidates.find((candidate) => candidate.url === script.url) ?? (candidates.length === 1 ? candidates[0] : void 0);
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
          included: /* @__PURE__ */ new Set([path]),
          url: script.url,
          executions: [],
          sourceType: path.endsWith(".cjs") ? "script" : "module"
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
      ...bundle.map ? { sourceMap: bundle.map } : {},
      // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
      ignoreSourceCode: (code) => code.trim() === "export"
    });
    map.merge(
      Object.fromEntries(
        Object.entries(converted).flatMap(([path, value]) => {
          const absolute = resolve(path);
          return bundle.included.has(absolute) ? [[absolute, { ...coverage.createFileCoverage(value).data, path: absolute }]] : [];
        })
      )
    );
  }
  phase("subprocessConversion", convertedScripts);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInRlc3QtY292ZXJhZ2UubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzRGVlcFN0cmljdEVxdWFsIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcGFyc2UgfSBmcm9tIFwiYWNvcm5cIjtcbmltcG9ydCBjb252ZXJ0IGZyb20gXCJhc3QtdjgtdG8taXN0YW5idWxcIjtcbmltcG9ydCB7IG1lcmdlUHJvY2Vzc0NvdnMgfSBmcm9tIFwiQGJjb2UvdjgtY292ZXJhZ2VcIjtcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIGxzdGF0U3luYyxcbiAgbWtkaXJTeW5jLFxuICBta2R0ZW1wU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICBybVN5bmMsXG4gIHN0YXRTeW5jLFxuICBzeW1saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoLCBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgY292ZXJhZ2UgZnJvbSBcImlzdGFuYnVsLWxpYi1jb3ZlcmFnZVwiO1xuaW1wb3J0IHJlcG9ydCBmcm9tIFwiaXN0YW5idWwtbGliLXJlcG9ydFwiO1xuaW1wb3J0IHJlcG9ydHMgZnJvbSBcImlzdGFuYnVsLXJlcG9ydHNcIjtcbmltcG9ydCB7IGJ1aWxkIH0gZnJvbSBcImVzYnVpbGRcIjtcbmltcG9ydCB7IGNvcHlTb3VyY2VDaGVja291dCB9IGZyb20gXCIuL3NvdXJjZS1jaGVja291dC5tanNcIjtcbmltcG9ydCB7IGJ1bmRsZU9wdGlvbnMgfSBmcm9tIFwiLi9idW5kbGUtb3B0aW9ucy5tanNcIjtcbmltcG9ydCB7XG4gIEludmFsaWROb2RlQ292ZXJhZ2VSZXBvcnQsXG4gIHJlYWROb2RlQ292ZXJhZ2VSZXBvcnRzLFxuICB0eXBlIENvdmVyYWdlU291cmNlTWFwLFxuICB0eXBlIE5vZGVDb3ZlcmFnZVJlcG9ydCxcbn0gZnJvbSBcIi4vbm9kZS1jb3ZlcmFnZS1yZXBvcnRzLm1qc1wiO1xuaW1wb3J0IHsgY292ZXJhZ2VSZXBvc2l0b3J5LCByZXBvcnRDb3ZlcmFnZUNoYW5nZSwgdHlwZSBNZXRyaWNOYW1lIH0gZnJvbSBcIi4vY292ZXJhZ2Utc3VtbWFyeS5tanNcIjtcblxuaW1wb3J0IHR5cGUgeyBQcm9maWxlciB9IGZyb20gXCJub2RlOmluc3BlY3RvclwiO1xuaW1wb3J0IHR5cGUgeyBDb3ZlcmFnZU1hcCwgRmlsZUNvdmVyYWdlRGF0YSB9IGZyb20gXCJpc3RhbmJ1bC1saWItY292ZXJhZ2VcIjtcbmltcG9ydCB7IHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbnRlcmZhY2UgTWVhc3VyZWRTY3JpcHQge1xuICBjb2RlOiBzdHJpbmc7XG4gIGluY2x1ZGVkOiBTZXQ8c3RyaW5nPjtcbiAgdXJsOiBzdHJpbmc7XG4gIGV4ZWN1dGlvbnM6IHsgcmVzdWx0OiBQcm9maWxlci5TY3JpcHRDb3ZlcmFnZVtdIH1bXTtcbiAgc291cmNlVHlwZTogXCJzY3JpcHRcIiB8IFwibW9kdWxlXCI7XG4gIG1hcD86IENvdmVyYWdlU291cmNlTWFwO1xufVxuXG5mdW5jdGlvbiByZWNvcmRFeGVjdXRpb24obWVhc3VyZWQ6IE1lYXN1cmVkU2NyaXB0LCBzY3JpcHQ6IE5vZGVDb3ZlcmFnZVJlcG9ydFtcInJlc3VsdFwiXVtudW1iZXJdKSB7XG4gIG1lYXN1cmVkLmV4ZWN1dGlvbnMucHVzaCh7XG4gICAgcmVzdWx0OiBbeyAuLi5zY3JpcHQsIHNjcmlwdElkOiBzY3JpcHQuc2NyaXB0SWQgPz8gc2NyaXB0LnVybCwgdXJsOiBtZWFzdXJlZC51cmwgfV0sXG4gIH0pO1xuICAvLyBSYXcgcmVwb3J0cyByZXBlYXRlZGx5IGNvbnRhaW4gdGhlIHNhbWUgbGFyZ2UgYnVuZGxlcy4gQm91bmQgcmV0YWluZWQgcmFuZ2VzXG4gIC8vIHdoaWxlIHByZXNlcnZpbmcgdGhlIFY4IG1lcmdlcidzIGJsb2NrLWNvdmVyYWdlIHByZWNlZGVuY2UgYW5kIGV4ZWN1dGlvbiBjb3VudHMuXG4gIGlmIChtZWFzdXJlZC5leGVjdXRpb25zLmxlbmd0aCA9PT0gMzIpIG1lYXN1cmVkLmV4ZWN1dGlvbnMgPSBbbWVyZ2VQcm9jZXNzQ292cyhtZWFzdXJlZC5leGVjdXRpb25zKV07XG59XG5cbnR5cGUgQ292ZXJhZ2VQaGFzZSA9XG4gIHwgXCJ3b3Jrc3BhY2VcIlxuICB8IFwidGVzdHNcIlxuICB8IFwic291cmNlTWFwc1wiXG4gIHwgXCJzdWJwcm9jZXNzUmVwb3J0c1wiXG4gIHwgXCJzdWJwcm9jZXNzQ29udmVyc2lvblwiXG4gIHwgXCJzdWJwcm9jZXNzXCJcbiAgfCBcInJlcG9ydGluZ1wiXG4gIHwgXCJjbGVhbnVwXCI7XG50eXBlIENvdmVyYWdlVGltaW5nID0gKHBoYXNlOiBDb3ZlcmFnZVBoYXNlLCBtaWxsaXNlY29uZHM6IG51bWJlciwgY291bnQ/OiBudW1iZXIpID0+IHZvaWQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ292ZXJhZ2VUaW1pbmdzIHtcbiAgdmVyc2lvbjogMTtcbiAgdG90YWxNczogbnVtYmVyO1xuICBwaGFzZXM6IFBhcnRpYWw8UmVjb3JkPENvdmVyYWdlUGhhc2UsIHsgbWlsbGlzZWNvbmRzOiBudW1iZXI7IGNvdW50PzogbnVtYmVyIH0+Pjtcbn1cblxuZnVuY3Rpb24gcGhhc2VUaW1pbmdzKHJlcG9ydD86IENvdmVyYWdlVGltaW5nKSB7XG4gIGxldCBzdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIHJldHVybiAocGhhc2U6IENvdmVyYWdlUGhhc2UsIGNvdW50PzogbnVtYmVyKSA9PiB7XG4gICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgcmVwb3J0Py4ocGhhc2UsIG5vdyAtIHN0YXJ0ZWQsIGNvdW50KTtcbiAgICBzdGFydGVkID0gbm93O1xuICB9O1xufVxuXG4vLyBJbnRlZ3JhdGlvbiB0ZXN0cyBsYXVuY2ggYW5kIGNvcHkgdGhlIGRpc3RyaWJ1dGlvbiBiZXNpZGUgdGhlaXIgdGVzdCBzb3VyY2VzLlxuLy8gR2l2ZSBjb3ZlcmFnZSBpdHMgb3duIGRpc3RyaWJ1dGlvbiB3aXRob3V0IGNoYW5naW5nIHRoZSBydW5uYWJsZSBjaGVja291dC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb3ZlcmFnZVdvcmtzcGFjZShyb290OiBzdHJpbmcsIHRlbXBvcmFyeTogc3RyaW5nKSB7XG4gIGlmICghW1wibWFpblwiLCBcInNraWxsc1wiXS5ldmVyeSgobmFtZSkgPT4gZXhpc3RzU3luYyhqb2luKHJvb3QsIGBzcmMvJHtuYW1lfS50c2ApKSkpIHJldHVybiByb290O1xuICBjb25zdCB3b3Jrc3BhY2UgPSBqb2luKHRlbXBvcmFyeSwgXCJwcm9qZWN0XCIpO1xuICBta2RpclN5bmMod29ya3NwYWNlKTtcbiAgY29weVNvdXJjZUNoZWNrb3V0KHJvb3QsIHdvcmtzcGFjZSk7XG4gIC8vIFJldXNlIGluc3RhbGxlZCBidWlsZC90ZXN0IGRlcGVuZGVuY2llczsgbmV2ZXIgY29weSBvciBkb3dubG9hZCB0aGVtIGZvciBjb3ZlcmFnZS5cbiAgY29uc3QgZGVwZW5kZW5jaWVzID0gcmVhbHBhdGhTeW5jLm5hdGl2ZShqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKTtcbiAgY29uc3QgZGVzdGluYXRpb24gPSBqb2luKHdvcmtzcGFjZSwgXCJub2RlX21vZHVsZXNcIik7XG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIpIHN5bWxpbmtTeW5jKGRlcGVuZGVuY2llcywgZGVzdGluYXRpb24sIFwianVuY3Rpb25cIik7XG4gIGVsc2Uge1xuICAgIC8vIFJlc29sdmUgcGFja2FnZSB0YXJnZXRzIGJlZm9yZSBjcm9zc2luZyBkcml2ZXM6IHBucG0ncyByZWxhdGl2ZSBwYWNrYWdlIGxpbmtzXG4gICAgLy8gbXVzdCByZXRhaW4gdGhlaXIgb3JpZ2luYWwgdmlydHVhbC1zdG9yZSBiYXNlIHRocm91Z2ggdGhlIGRpc3Bvc2FibGUgd29ya3NwYWNlLlxuICAgIG1rZGlyU3luYyhkZXN0aW5hdGlvbik7XG4gICAgY29uc3QgbGluayA9IChzb3VyY2U6IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGNhbm9uaWNhbCA9IHJlYWxwYXRoU3luYy5uYXRpdmUoc291cmNlKTtcbiAgICAgIHN5bWxpbmtTeW5jKGNhbm9uaWNhbCwgdGFyZ2V0LCBzdGF0U3luYyhjYW5vbmljYWwpLmlzRGlyZWN0b3J5KCkgPyBcImp1bmN0aW9uXCIgOiBcImZpbGVcIik7XG4gICAgfTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRlcGVuZGVuY2llcykpIHtcbiAgICAgIGNvbnN0IHNvdXJjZSA9IGpvaW4oZGVwZW5kZW5jaWVzLCBlbnRyeSk7XG4gICAgICBjb25zdCB0YXJnZXQgPSBqb2luKGRlc3RpbmF0aW9uLCBlbnRyeSk7XG4gICAgICBpZiAoIWVudHJ5LnN0YXJ0c1dpdGgoXCJAXCIpKSBsaW5rKHNvdXJjZSwgdGFyZ2V0KTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBta2RpclN5bmModGFyZ2V0KTtcbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKHNvdXJjZSkpIGxpbmsoam9pbihzb3VyY2UsIG5hbWUpLCBqb2luKHRhcmdldCwgbmFtZSkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wibWFpblwiLCBcInNraWxsc1wiLCBcInBhY2thZ2VcIiwgXCJsYXVuY2hlclwiLCBcImJvb3RzdHJhcFwiXSlcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKHdvcmtzcGFjZSwgYHNyYy8ke25hbWV9LnRzYCkpKSBhd2FpdCBidWlsZChidW5kbGVPcHRpb25zKHdvcmtzcGFjZSwgbmFtZSwgdHJ1ZSkpO1xuICByZXR1cm4gd29ya3NwYWNlO1xufVxuXG4vLyBVc2UgdGhlIHNhbWUgQVNULWF3YXJlIGNvbnZlcnNpb24gYXMgVml0ZXN0LiBNYXRjaCBmdWxsIG1hcCBjb250ZW50cyBiZWZvcmUgYXR0cmlidXRpbmcgYSBjb3BpZWQgYnVuZGxlLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN1YnByb2Nlc3NDb3ZlcmFnZShkaXJlY3Rvcnk6IHN0cmluZywgcm9vdDogc3RyaW5nLCByZXBvcnRUaW1pbmc/OiBDb3ZlcmFnZVRpbWluZykge1xuICBjb25zdCBwaGFzZSA9IHBoYXNlVGltaW5ncyhyZXBvcnRUaW1pbmcpO1xuICBjb25zdCBpZGVudGl0eSA9IChtYXA6IENvdmVyYWdlU291cmNlTWFwLCB1cmw6IHN0cmluZykgPT5cbiAgICBKU09OLnN0cmluZ2lmeShcbiAgICAgIG1hcC5maWxlID8/XG4gICAgICAgIG1hcC5zb3VyY2VzLm1hcCgoc291cmNlKSA9PiB7XG4gICAgICAgICAgY29uc3QgZGlyZWN0b3J5ID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKHVybCkpO1xuICAgICAgICAgIGNvbnN0IHBhdGggPSBzb3VyY2U/LnN0YXJ0c1dpdGgoXCJmaWxlOlwiKVxuICAgICAgICAgICAgPyBmaWxlVVJMVG9QYXRoKHNvdXJjZSlcbiAgICAgICAgICAgIDogcmVzb2x2ZShkaXJlY3RvcnksIG1hcC5zb3VyY2VSb290ID8/IFwiXCIsIHNvdXJjZSA/PyBcIlwiKTtcbiAgICAgICAgICByZXR1cm4gcmVsYXRpdmUoZGlyZWN0b3J5LCBwYXRoKS5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuICAgICAgICB9KSxcbiAgICApO1xuICBjb25zdCBidW5kbGVzID0gbmV3IE1hcDxzdHJpbmcsIE1lYXN1cmVkU2NyaXB0W10+KCk7XG4gIGNvbnN0IGhlbHBlcnMgPSBuZXcgTWFwPHN0cmluZywgTWVhc3VyZWRTY3JpcHQ+KCk7XG4gIGNvbnN0IHNvdXJjZXMgPSAoZGlyZWN0b3J5OiBzdHJpbmcpOiBzdHJpbmdbXSA9PiB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGRpcmVjdG9yeSkpIHJldHVybiBbXTtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyZWN0b3J5LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkuZmxhdE1hcCgoZW50cnkpID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSBqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSk7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkgcmV0dXJuIHNvdXJjZXMocGF0aCk7XG4gICAgICByZXR1cm4gZW50cnkuaXNGaWxlKCkgJiYgL1xcLig/Om1qc3xjanN8anMpJC8udGVzdChlbnRyeS5uYW1lKSA/IFtwYXRoXSA6IFtdO1xuICAgIH0pO1xuICB9O1xuICBmb3IgKGNvbnN0IHBhdGggb2YgW1wiYnVuZGxlXCIsIFwic2NyaXB0c1wiLCBcImJpblwiXS5mbGF0TWFwKChuYW1lKSA9PiBzb3VyY2VzKGpvaW4ocm9vdCwgbmFtZSkpKSkge1xuICAgIGNvbnN0IGNvZGUgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IGVuY29kZWQgPSAvc291cmNlTWFwcGluZ1VSTD1kYXRhOmFwcGxpY2F0aW9uXFwvanNvbig/OjtjaGFyc2V0PXV0Zi04KT87YmFzZTY0LChbXlxcc10rKS8uZXhlYyhjb2RlKT8uWzFdO1xuICAgIGlmICghZW5jb2RlZCkge1xuICAgICAgaWYgKGRpcm5hbWUocGF0aCkgPT09IGpvaW4ocm9vdCwgXCJidW5kbGVcIikgJiYgcGF0aC5lbmRzV2l0aChcIi5janNcIikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtwYXRofTogYnVuZGxlIG5lZWRzIGFuIGlubGluZSBzb3VyY2UgbWFwYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgbWFwID0gSlNPTi5wYXJzZShCdWZmZXIuZnJvbShlbmNvZGVkLCBcImJhc2U2NFwiKS50b1N0cmluZyhcInV0ZjhcIikpIGFzIENvdmVyYWdlU291cmNlTWFwO1xuICAgIGNvbnN0IHVybCA9IHBhdGhUb0ZpbGVVUkwocGF0aCkuaHJlZjtcbiAgICBjb25zdCBrZXkgPSBpZGVudGl0eShtYXAsIHVybCk7XG4gICAgY29uc3QgaW5jbHVkZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBjb25zdCBtYXBwZWQgPSB7XG4gICAgICAuLi5tYXAsXG4gICAgICBzb3VyY2VzOiBtYXAuc291cmNlcy5tYXAoKHNvdXJjZSwgaW5kZXgpID0+IHtcbiAgICAgICAgY29uc3Qgc291cmNlUGF0aCA9IHJlc29sdmUoZGlybmFtZShwYXRoKSwgbWFwLnNvdXJjZVJvb3QgPz8gXCJcIiwgc291cmNlID8/IFwiXCIpO1xuICAgICAgICBpZiAoW1wic3JjXCIsIFwic2NyaXB0c1wiLCBcImJpblwiXS5zb21lKChuYW1lKSA9PiBzb3VyY2VQYXRoLnN0YXJ0c1dpdGgoam9pbihyb290LCBuYW1lKSArIHNlcCkpKSB7XG4gICAgICAgICAgaWYgKCFleGlzdHNTeW5jKHNvdXJjZVBhdGgpIHx8IHJlYWRGaWxlU3luYyhzb3VyY2VQYXRoLCBcInV0ZjhcIikgIT09IG1hcC5zb3VyY2VzQ29udGVudD8uW2luZGV4XSlcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtzb3VyY2VQYXRofTogZW1pdHRlZCBzb3VyY2UgZGlmZmVycyBmcm9tIHRoZSBjaGVja291dGApO1xuICAgICAgICAgIGluY2x1ZGVkLmFkZChzb3VyY2VQYXRoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBSZWxhdGl2ZSBVUkxzIGF2b2lkIHRyZWF0aW5nIFdpbmRvd3MgZHJpdmUgbGV0dGVycyBhcyBVUkkgc2NoZW1lcy5cbiAgICAgICAgcmV0dXJuIHJlbGF0aXZlKGRpcm5hbWUocGF0aCksIHNvdXJjZVBhdGgpLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG4gICAgICB9KSxcbiAgICB9O1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBidW5kbGVzLmdldChrZXkpID8/IFtdO1xuICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICBjb2RlLFxuICAgICAgbWFwOiBtYXBwZWQsXG4gICAgICBpbmNsdWRlZCxcbiAgICAgIHVybCxcbiAgICAgIGV4ZWN1dGlvbnM6IFtdLFxuICAgICAgc291cmNlVHlwZTogcGF0aC5lbmRzV2l0aChcIi5janNcIikgPyBcInNjcmlwdFwiIDogXCJtb2R1bGVcIixcbiAgICB9KTtcbiAgICBidW5kbGVzLnNldChrZXksIGNhbmRpZGF0ZXMpO1xuICB9XG4gIHBoYXNlKFxuICAgIFwic291cmNlTWFwc1wiLFxuICAgIFsuLi5idW5kbGVzLnZhbHVlcygpXS5yZWR1Y2UoKGNvdW50LCBjYW5kaWRhdGVzKSA9PiBjb3VudCArIGNhbmRpZGF0ZXMubGVuZ3RoLCAwKSxcbiAgKTtcbiAgbGV0IHJlcG9ydENvdW50ID0gMDtcbiAgZm9yIChjb25zdCBkYXRhIG9mIHJlYWROb2RlQ292ZXJhZ2VSZXBvcnRzKGRpcmVjdG9yeSkpIHtcbiAgICByZXBvcnRDb3VudCsrO1xuICAgIGZvciAoY29uc3Qgc2NyaXB0IG9mIGRhdGEucmVzdWx0KSB7XG4gICAgICBjb25zdCBtYXAgPSBkYXRhW1wic291cmNlLW1hcC1jYWNoZVwiXT8uW3NjcmlwdC51cmxdPy5kYXRhO1xuICAgICAgaWYgKG1hcCkge1xuICAgICAgICBpZiAoIXNjcmlwdC51cmwuc3RhcnRzV2l0aChcImZpbGU6XCIpKSBjb250aW51ZTtcbiAgICAgICAgLy8gSW5kZXggYnkgcG9ydGFibGUgaWRlbnRpdHksIHRoZW4gY29tcGFyZSBldmVyeSBhdHRyaWJ1dGVkIG1hcCBmaWVsZCBleGFjdGx5LlxuICAgICAgICAvLyBSZS1zZXJpYWxpemluZyBhbmQgaGFzaGluZyByZXBlYXRlZCBtdWx0aS1tZWdhYnl0ZSBtYXBzIGNyZWF0ZXMgYXZvaWRhYmxlIGdhcmJhZ2UuXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSAoYnVuZGxlcy5nZXQoaWRlbnRpdHkobWFwLCBzY3JpcHQudXJsKSkgPz8gW10pLmZpbHRlcihcbiAgICAgICAgICAoY2FuZGlkYXRlKSA9PlxuICAgICAgICAgICAgbWFwLm1hcHBpbmdzID09PSBjYW5kaWRhdGUubWFwPy5tYXBwaW5ncyAmJlxuICAgICAgICAgICAgaXNEZWVwU3RyaWN0RXF1YWwobWFwLm5hbWVzLCBjYW5kaWRhdGUubWFwLm5hbWVzKSAmJlxuICAgICAgICAgICAgaXNEZWVwU3RyaWN0RXF1YWwobWFwLnNvdXJjZXNDb250ZW50LCBjYW5kaWRhdGUubWFwLnNvdXJjZXNDb250ZW50KSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgYnVuZGxlID1cbiAgICAgICAgICBjYW5kaWRhdGVzLmZpbmQoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLnVybCA9PT0gc2NyaXB0LnVybCkgPz9cbiAgICAgICAgICAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDEgPyBjYW5kaWRhdGVzWzBdIDogdW5kZWZpbmVkKTtcbiAgICAgICAgaWYgKCFidW5kbGUgJiYgY2FuZGlkYXRlcy5sZW5ndGggPiAxKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtzY3JpcHQudXJsfTogY29waWVkIGNvdmVyYWdlIHNvdXJjZSBpcyBhbWJpZ3VvdXM7IGVtaXQgYSB1bmlxdWUgc291cmNlLW1hcCBmaWxlIGlkZW50aXR5YCk7XG4gICAgICAgIGlmICghYnVuZGxlKSBjb250aW51ZTtcbiAgICAgICAgcmVjb3JkRXhlY3V0aW9uKGJ1bmRsZSwgc2NyaXB0KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoIXNjcmlwdC51cmwuc3RhcnRzV2l0aChcImZpbGU6XCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBhdGggPSBmaWxlVVJMVG9QYXRoKHNjcmlwdC51cmwpO1xuICAgICAgaWYgKCEvXig/OnNjcmlwdHNcXC8uKnxiaW5cXC9bXi9dKylcXC4oPzpqc3xtanN8Y2pzKSQvLnRlc3QocmVsYXRpdmUocm9vdCwgcGF0aCkuc3BsaXQoc2VwKS5qb2luKFwiL1wiKSkpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB0aHJvdyBuZXcgRXJyb3IoYCR7cGF0aH06IG1lYXN1cmVkIGhlbHBlciBpcyBtaXNzaW5nIGZyb20gdGhlIGNoZWNrb3V0YCk7XG4gICAgICBsZXQgaGVscGVyID0gaGVscGVycy5nZXQocGF0aCk7XG4gICAgICBpZiAoIWhlbHBlcikge1xuICAgICAgICBoZWxwZXIgPSB7XG4gICAgICAgICAgY29kZTogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSxcbiAgICAgICAgICBpbmNsdWRlZDogbmV3IFNldChbcGF0aF0pLFxuICAgICAgICAgIHVybDogc2NyaXB0LnVybCxcbiAgICAgICAgICBleGVjdXRpb25zOiBbXSxcbiAgICAgICAgICBzb3VyY2VUeXBlOiBwYXRoLmVuZHNXaXRoKFwiLmNqc1wiKSA/IFwic2NyaXB0XCIgOiBcIm1vZHVsZVwiLFxuICAgICAgICB9O1xuICAgICAgICBoZWxwZXJzLnNldChwYXRoLCBoZWxwZXIpO1xuICAgICAgfVxuICAgICAgcmVjb3JkRXhlY3V0aW9uKGhlbHBlciwgc2NyaXB0KTtcbiAgICB9XG4gIH1cbiAgcGhhc2UoXCJzdWJwcm9jZXNzUmVwb3J0c1wiLCByZXBvcnRDb3VudCk7XG4gIGNvbnN0IG1hcCA9IGNvdmVyYWdlLmNyZWF0ZUNvdmVyYWdlTWFwKHt9KTtcbiAgbGV0IGNvbnZlcnRlZFNjcmlwdHMgPSAwO1xuICBmb3IgKGNvbnN0IGJ1bmRsZSBvZiBbLi4uWy4uLmJ1bmRsZXMudmFsdWVzKCldLmZsYXQoKSwgLi4uaGVscGVycy52YWx1ZXMoKV0pIHtcbiAgICBjb25zdCBtZXJnZWQgPSBtZXJnZVByb2Nlc3NDb3ZzKGJ1bmRsZS5leGVjdXRpb25zKTtcbiAgICBidW5kbGUuZXhlY3V0aW9ucy5sZW5ndGggPSAwO1xuICAgIGlmICghbWVyZ2VkLnJlc3VsdC5sZW5ndGgpIGNvbnRpbnVlO1xuICAgIGNvbnZlcnRlZFNjcmlwdHMrKztcbiAgICBjb25zdCBjb252ZXJ0ZWQgPSBhd2FpdCBjb252ZXJ0KHtcbiAgICAgIGNvZGU6IGJ1bmRsZS5jb2RlLFxuICAgICAgYXN0OiBwYXJzZShidW5kbGUuY29kZSwgeyBlY21hVmVyc2lvbjogXCJsYXRlc3RcIiwgbG9jYXRpb25zOiB0cnVlLCBzb3VyY2VUeXBlOiBidW5kbGUuc291cmNlVHlwZSB9KSxcbiAgICAgIHdyYXBwZXJMZW5ndGg6IDAsXG4gICAgICBjb3ZlcmFnZTogcmVxdWlyZWQobWVyZ2VkLnJlc3VsdFswXSwgXCJNZXJnZWQgY292ZXJhZ2UgbXVzdCByZXRhaW4gaXRzIHNjcmlwdFwiKSxcbiAgICAgIC4uLihidW5kbGUubWFwID8geyBzb3VyY2VNYXA6IGJ1bmRsZS5tYXAgfSA6IHt9KSxcbiAgICAgIC8vIGVzYnVpbGQncyBnZW5lcmF0ZWQgZXhwb3J0IGdldHRlcnMgbWFwIHRvIHRoZSBgZXhwb3J0YCBrZXl3b3JkLCBub3QgYSBzb3VyY2UgZnVuY3Rpb24gb3Igc3RhdGVtZW50LlxuICAgICAgaWdub3JlU291cmNlQ29kZTogKGNvZGUpID0+IGNvZGUudHJpbSgpID09PSBcImV4cG9ydFwiLFxuICAgIH0pO1xuICAgIG1hcC5tZXJnZShcbiAgICAgIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgT2JqZWN0LmVudHJpZXMoY29udmVydGVkKS5mbGF0TWFwKChbcGF0aCwgdmFsdWVdKSA9PiB7XG4gICAgICAgICAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHBhdGgpO1xuICAgICAgICAgIHJldHVybiBidW5kbGUuaW5jbHVkZWQuaGFzKGFic29sdXRlKVxuICAgICAgICAgICAgPyBbW2Fic29sdXRlLCB7IC4uLmNvdmVyYWdlLmNyZWF0ZUZpbGVDb3ZlcmFnZSh2YWx1ZSkuZGF0YSwgcGF0aDogYWJzb2x1dGUgfV1dXG4gICAgICAgICAgICA6IFtdO1xuICAgICAgICB9KSxcbiAgICAgICksXG4gICAgKTtcbiAgfVxuICBwaGFzZShcInN1YnByb2Nlc3NDb252ZXJzaW9uXCIsIGNvbnZlcnRlZFNjcmlwdHMpO1xuICByZXR1cm4gbWFwO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VDb3ZlcmFnZShcbiAgcGF0aHM6IHN0cmluZ1tdLFxuICBkaXJlY3Rvcnk6IHN0cmluZyxcbiAgdGhyZXNob2xkczogUGFydGlhbDxSZWNvcmQ8TWV0cmljTmFtZSwgbnVtYmVyPj4sXG4gIHNvdXJjZVJvb3QgPSBwcm9jZXNzLmN3ZCgpLFxuICByZXBvcnRSb290ID0gc291cmNlUm9vdCxcbiAgcHJlc2VudD86IChtYXA6IENvdmVyYWdlTWFwKSA9PiB2b2lkLFxuKSB7XG4gIGNvbnN0IG1hcCA9IGNvdmVyYWdlLmNyZWF0ZUNvdmVyYWdlTWFwKHt9KTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgUmVjb3JkPHN0cmluZywgRmlsZUNvdmVyYWdlRGF0YT47XG4gICAgY29uc3QgcmVtYXBwZWQgPVxuICAgICAgc291cmNlUm9vdCA9PT0gcmVwb3J0Um9vdFxuICAgICAgICA/IGRhdGFcbiAgICAgICAgOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgICAgICBPYmplY3QuZW50cmllcyhkYXRhKS5tYXAoKFtmaWxlLCB2YWx1ZV0pID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKGZpbGUpO1xuICAgICAgICAgICAgICBpZiAoIWFic29sdXRlLnN0YXJ0c1dpdGgoc291cmNlUm9vdCArIHNlcCkpIHRocm93IG5ldyBFcnJvcihgY292ZXJhZ2UgcGF0aCBvdXRzaWRlIHdvcmtzcGFjZTogJHtmaWxlfWApO1xuICAgICAgICAgICAgICBjb25zdCBjYW5vbmljYWwgPSBqb2luKHJlcG9ydFJvb3QsIHJlbGF0aXZlKHNvdXJjZVJvb3QsIGFic29sdXRlKSk7XG4gICAgICAgICAgICAgIHJldHVybiBbY2Fub25pY2FsLCB7IC4uLnZhbHVlLCBwYXRoOiBjYW5vbmljYWwgfV07XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgIG1hcC5tZXJnZShyZW1hcHBlZCk7XG4gIH1cbiAgY29uc3QgY29udGV4dCA9IHJlcG9ydC5jcmVhdGVDb250ZXh0KHsgZGlyOiBkaXJlY3RvcnksIGNvdmVyYWdlTWFwOiBtYXAgfSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJ0ZXh0XCIsIFwianNvbi1zdW1tYXJ5XCIsIFwianNvblwiXSBhcyBjb25zdCkgcmVwb3J0cy5jcmVhdGUobmFtZSkuZXhlY3V0ZShjb250ZXh0KTtcbiAgcHJlc2VudD8uKG1hcCk7XG4gIGNvbnN0IHN1bW1hcnkgPSBtYXAuZ2V0Q292ZXJhZ2VTdW1tYXJ5KCk7XG4gIGlmICghc3VtbWFyeS5saW5lcy50b3RhbCB8fCAhc3VtbWFyeS5mdW5jdGlvbnMudG90YWwpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgY29udGFpbnMgbm8gbWVhc3VyZWQgbGluZXMgb3IgZnVuY3Rpb25zXCIpO1xuICBmb3IgKGNvbnN0IG1ldHJpYyBvZiBbXCJsaW5lc1wiLCBcImZ1bmN0aW9uc1wiLCBcImJyYW5jaGVzXCIsIFwic3RhdGVtZW50c1wiXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG1pbmltdW0gPSB0aHJlc2hvbGRzW21ldHJpY107XG4gICAgY29uc3QgcGVyY2VudGFnZSA9IHN1bW1hcnlbbWV0cmljXS5wY3Q7XG4gICAgaWYgKG1pbmltdW0gIT09IHVuZGVmaW5lZCAmJiAodHlwZW9mIHBlcmNlbnRhZ2UgIT09IFwibnVtYmVyXCIgfHwgcGVyY2VudGFnZSA8IG1pbmltdW0pKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke21ldHJpY30gY292ZXJhZ2UgJHtTdHJpbmcocGVyY2VudGFnZSl9JSBpcyBiZWxvdyAke1N0cmluZyhtaW5pbXVtKX0lYCk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkNvdmVyYWdlKHJvb3Q6IHN0cmluZywgYnVpbGRzID0gam9pbihyb290LCBcImJ1aWxkXCIpKSB7XG4gIGNvbnN0IHN0YXJ0ZWQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdGltaW5nczogQ292ZXJhZ2VUaW1pbmdzID0geyB2ZXJzaW9uOiAxLCB0b3RhbE1zOiAwLCBwaGFzZXM6IHt9IH07XG4gIGNvbnN0IHJlcG9ydFRpbWluZzogQ292ZXJhZ2VUaW1pbmcgPSAocGhhc2UsIG1pbGxpc2Vjb25kcywgY291bnQpID0+IHtcbiAgICB0aW1pbmdzLnBoYXNlc1twaGFzZV0gPSB7IG1pbGxpc2Vjb25kcywgLi4uKGNvdW50ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgY291bnQgfSkgfTtcbiAgICBjb25zb2xlLmVycm9yKGBDb3ZlcmFnZSAke3BoYXNlfTogJHsobWlsbGlzZWNvbmRzIC8gMTAwMCkudG9GaXhlZCgyKX1zYCk7XG4gIH07XG4gIGNvbnN0IHBoYXNlID0gcGhhc2VUaW1pbmdzKHJlcG9ydFRpbWluZyk7XG4gIHJvb3QgPSByZWFscGF0aFN5bmMubmF0aXZlKHJvb3QpO1xuICBjb25zdCBvdXRwdXQgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIik7XG4gIGlmIChleGlzdHNTeW5jKG91dHB1dCkgJiYgbHN0YXRTeW5jKG91dHB1dCkuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gUHJlc2VydmUgdGhlIHRyYWNrZWQgYmFzZWxpbmUgaWYgdGVzdCBjb2xsZWN0aW9uIGZhaWxzIGJlZm9yZSBhIHJlcGxhY2VtZW50IGV4aXN0cy5cbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKG91dHB1dCkpXG4gICAgaWYgKG5hbWUgIT09IFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpIHJtU3luYyhqb2luKG91dHB1dCwgbmFtZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgY29uc3Qgc3VtbWFyeVBhdGggPSBqb2luKG91dHB1dCwgXCJjb3ZlcmFnZS1zdW1tYXJ5Lmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSAmJiBsc3RhdFN5bmMoc3VtbWFyeVBhdGgpLmlzU3ltYm9saWNMaW5rKCkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2Ugc3VtbWFyeSBtdXN0IGJlIGEgcmVndWxhciBmaWxlXCIpO1xuICBta2RpclN5bmMoYnVpbGRzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbihyZWFscGF0aFN5bmMubmF0aXZlKGJ1aWxkcyksIFwiY292ZXJhZ2UtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB3b3Jrc3BhY2UgPSBhd2FpdCBjb3ZlcmFnZVdvcmtzcGFjZShyZXNvbHZlKHJvb3QpLCB0ZW1wb3JhcnkpO1xuICAgIHBoYXNlKFwid29ya3NwYWNlXCIpO1xuICAgIGNvbnN0IHNvdXJjZSA9IHNwYXduU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCJdLCB7IGN3ZDogY292ZXJhZ2VSZXBvc2l0b3J5KHJvb3QpLCBlbmNvZGluZzogXCJ1dGY4XCIgfSk7XG4gICAgY29uc3QgcmV2aXNpb24gPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfU09VUkNFX1JFVklTSU9OID8/IChzb3VyY2Uuc3RhdHVzID09PSAwID8gc291cmNlLnN0ZG91dC50cmltKCkgOiB1bmRlZmluZWQpO1xuICAgIGNvbnN0IHJhdyA9IGpvaW4odGVtcG9yYXJ5LCBcInJhd1wiKTtcbiAgICBjb25zdCB1bml0ID0gam9pbih0ZW1wb3JhcnksIFwidW5pdFwiKTtcbiAgICBjb25zdCB0ZXN0cyA9IHNwYXduU3luYyhcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXCJub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanNcIiwgXCJydW5cIiwgXCItLWNvdmVyYWdlXCIsIFwiLS1jb3ZlcmFnZS5yZXBvcnRzRGlyZWN0b3J5XCIsIHVuaXRdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHdvcmtzcGFjZSxcbiAgICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgICAvLyBWaXRlc3QgYWxyZWFkeSBtZWFzdXJlcyBpdHMgd29ya2Vycy4gVGhlaXIgc2V0dXAgZW5hYmxlcyBuYXRpdmUgVjggY2FwdHVyZSBvbmx5IGZvciBDTEkgY2hpbGRyZW4uXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIE5PREVfVjhfQ09WRVJBR0U6IFwiXCIsXG4gICAgICAgICAgV09SS0JFTkNIX1NVQlBST0NFU1NfQ09WRVJBR0U6IHJhdyxcbiAgICAgICAgICAuLi4ocmV2aXNpb24gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBXT1JLQkVOQ0hfU09VUkNFX1JFVklTSU9OOiByZXZpc2lvbiB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCByZXN1bHRzUGF0aCA9IGpvaW4od29ya3NwYWNlLCBcImNvdmVyYWdlL3Rlc3RzLmpzb25cIik7XG4gICAgaWYgKGV4aXN0c1N5bmMocmVzdWx0c1BhdGgpKSB7XG4gICAgICBjb25zdCByZXN1bHRzID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVzdWx0c1BhdGgsIFwidXRmOFwiKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAvLyBEZWRpY2F0ZWQgY292ZXJhZ2UgcmVwb3J0cyByZXRhaW4gdGhlIG1hcDsgdGVzdCBldmlkZW5jZSByZXRhaW5zIG91dGNvbWVzLCBkaWFnbm9zdGljcywgYW5kIHRpbWluZ3MuXG4gICAgICBkZWxldGUgcmVzdWx0cy5jb3ZlcmFnZU1hcDtcbiAgICAgIGNvbnN0IHJlbWFwID0gKHZhbHVlOiB1bmtub3duKTogdW5rbm93biA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpXG4gICAgICAgICAgcmV0dXJuIHZhbHVlXG4gICAgICAgICAgICAucmVwbGFjZUFsbCh3b3Jrc3BhY2UgKyBzZXAsIHJlc29sdmUocm9vdCkgKyBzZXApXG4gICAgICAgICAgICAucmVwbGFjZUFsbCh3b3Jrc3BhY2UucmVwbGFjZUFsbChzZXAsIFwiL1wiKSArIFwiL1wiLCByZXNvbHZlKHJvb3QpLnJlcGxhY2VBbGwoc2VwLCBcIi9cIikgKyBcIi9cIik7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcChyZW1hcCk7XG4gICAgICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpXG4gICAgICAgICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyh2YWx1ZSkubWFwKChba2V5LCBlbnRyeV0pID0+IFtrZXksIHJlbWFwKGVudHJ5KV0pKTtcbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXQsIFwidGVzdHMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocmVtYXAocmVzdWx0cykpKTtcbiAgICB9XG4gICAgcGhhc2UoXCJ0ZXN0c1wiKTtcbiAgICBpZiAodGVzdHMuZXJyb3IgfHwgdGVzdHMuc3RhdHVzICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoXCJ0ZXN0cyBvciBjb3ZlcmFnZSBjb2xsZWN0aW9uIGZhaWxlZFwiKTtcbiAgICBjb25zdCBjbGkgPSBqb2luKHRlbXBvcmFyeSwgXCJjbGkuanNvblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGNsaSwgSlNPTi5zdHJpbmdpZnkoYXdhaXQgc3VicHJvY2Vzc0NvdmVyYWdlKHJhdywgd29ya3NwYWNlLCByZXBvcnRUaW1pbmcpKSk7XG4gICAgcGhhc2UoXCJzdWJwcm9jZXNzXCIpO1xuICAgIGNvbnN0IHBvbGljeSA9IChcbiAgICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvcXVhbGl0eS5qc29uXCIpLCBcInV0ZjhcIikpIGFzIHsgY292ZXJhZ2U6IFJlY29yZDxNZXRyaWNOYW1lLCBudW1iZXI+IH1cbiAgICApLmNvdmVyYWdlO1xuICAgIGNvbnN0IG1hcCA9IG1lcmdlQ292ZXJhZ2UoXG4gICAgICBbam9pbih1bml0LCBcImNvdmVyYWdlLWZpbmFsLmpzb25cIiksIGNsaV0sXG4gICAgICBvdXRwdXQsXG4gICAgICBPYmplY3QuZnJvbUVudHJpZXMoKFtcImxpbmVzXCIsIFwiZnVuY3Rpb25zXCIsIFwiYnJhbmNoZXNcIiwgXCJzdGF0ZW1lbnRzXCJdIGFzIGNvbnN0KS5tYXAoKGtleSkgPT4gW2tleSwgcG9saWN5W2tleV1dKSksXG4gICAgICB3b3Jrc3BhY2UsXG4gICAgICByZXNvbHZlKHJvb3QpLFxuICAgICAgKG1hcDogY292ZXJhZ2UuQ292ZXJhZ2VNYXApID0+IHJlcG9ydENvdmVyYWdlQ2hhbmdlKG1hcCwgcmVzb2x2ZShyb290KSwgam9pbihvdXRwdXQsIFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpKSxcbiAgICApO1xuICAgIHBoYXNlKFwicmVwb3J0aW5nXCIpO1xuICAgIHJldHVybiBtYXA7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgSW52YWxpZE5vZGVDb3ZlcmFnZVJlcG9ydCkge1xuICAgICAgY29uc3QgZGlhZ25vc3RpYyA9IGpvaW4ob3V0cHV0LCBcImNvbGxlY3Rpb24tZXJyb3IuanNvblwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoZGlhZ25vc3RpYywgSlNPTi5zdHJpbmdpZnkoZXJyb3IuZGlhZ25vc3RpYywgbnVsbCwgMikgKyBcIlxcblwiKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYENvdmVyYWdlIGNvbGxlY3Rpb24gZGlhZ25vc3RpY3M6ICR7ZGlhZ25vc3RpY31gKTtcbiAgICB9XG4gICAgdGhyb3cgZXJyb3I7XG4gIH0gZmluYWxseSB7XG4gICAgLy8gUmF3IFY4IG91dHB1dCBjb250YWlucyByZXBlYXRlZCBzb3VyY2UgbWFwcyBhbmQgY2FuIGR3YXJmIHRoZSBmaW5hbCByZXBvcnRzLlxuICAgIGNvbnN0IGNsZWFudXBTdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJlcG9ydFRpbWluZyhcImNsZWFudXBcIiwgcGVyZm9ybWFuY2Uubm93KCkgLSBjbGVhbnVwU3RhcnRlZCk7XG4gICAgdGltaW5ncy50b3RhbE1zID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydGVkO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcInRpbWluZ3MuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkodGltaW5ncywgbnVsbCwgMikgKyBcIlxcblwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE9ic2VydmF0aW9uYWwgdGltaW5nIG91dHB1dCBtdXN0IG5vdCByZXBsYWNlIGEgdGVzdCBvciBjb2xsZWN0aW9uIGZhaWx1cmUuXG4gICAgICBjb25zb2xlLmVycm9yKFwiQ292ZXJhZ2UgdGltaW5ncyBjb3VsZCBub3QgYmUgd3JpdHRlbi5cIik7XG4gICAgfVxuICB9XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pID09PSBmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpXG4gIGF3YWl0IHJ1bkNvdmVyYWdlKHByb2Nlc3MuY3dkKCksIHByb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMRF9ESVIpO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxhQUFhO0FBQ3RCLE9BQU8sYUFBYTtBQUNwQixTQUFTLHdCQUF3QjtBQUNqQyxTQUFT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SyxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFBQSxNQUMvRztBQUFBLE1BQ0EsUUFBUSxJQUFJO0FBQUEsTUFDWixDQUFDRixTQUE4QixxQkFBcUJBLE1BQUssUUFBUSxJQUFJLEdBQUcsS0FBSyxRQUFRLHVCQUF1QixDQUFDO0FBQUEsSUFDL0c7QUFDQSxVQUFNLFdBQVc7QUFDakIsV0FBTztBQUFBLEVBQ1QsU0FBUyxPQUFPO0FBQ2QsUUFBSSxpQkFBaUIsMkJBQTJCO0FBQzlDLFlBQU0sYUFBYSxLQUFLLFFBQVEsdUJBQXVCO0FBQ3ZELG9CQUFjLFlBQVksS0FBSyxVQUFVLE1BQU0sWUFBWSxNQUFNLENBQUMsSUFBSSxJQUFJO0FBQzFFLGNBQVEsTUFBTSxvQ0FBb0MsVUFBVSxFQUFFO0FBQUEsSUFDaEU7QUFDQSxVQUFNO0FBQUEsRUFDUixVQUFFO0FBRUEsVUFBTSxpQkFBaUIsWUFBWSxJQUFJO0FBQ3ZDLFdBQU8sV0FBVyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUNsRCxpQkFBYSxXQUFXLFlBQVksSUFBSSxJQUFJLGNBQWM7QUFDMUQsWUFBUSxVQUFVLFlBQVksSUFBSSxJQUFJO0FBQ3RDLFFBQUk7QUFDRixvQkFBYyxLQUFLLFFBQVEsY0FBYyxHQUFHLEtBQUssVUFBVSxTQUFTLE1BQU0sQ0FBQyxJQUFJLElBQUk7QUFBQSxJQUNyRixRQUFRO0FBRU4sY0FBUSxNQUFNLHdDQUF3QztBQUFBLElBQ3hEO0FBQUEsRUFDRjtBQUNGO0FBRUEsSUFBSSxRQUFRLEtBQUssQ0FBQyxLQUFLLFFBQVEsUUFBUSxLQUFLLENBQUMsQ0FBQyxNQUFNLGNBQWMsWUFBWSxHQUFHO0FBQy9FLFFBQU0sWUFBWSxRQUFRLElBQUksR0FBRyxRQUFRLElBQUksbUJBQW1COyIsIm5hbWVzIjpbInJlcG9ydCIsIm1hcCIsImRpcmVjdG9yeSIsInBoYXNlIl0sImZpbGUiOiJzY3JpcHRzL3Rlc3QtY292ZXJhZ2UubWpzIn0=
