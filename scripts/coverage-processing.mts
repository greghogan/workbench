import { isDeepStrictEqual } from "node:util";
import { parse } from "acorn";
import convert from "ast-v8-to-istanbul";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import coverage from "istanbul-lib-coverage";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profiler } from "node:inspector";
import type { FileCoverageData } from "istanbul-lib-coverage";
import { readNodeCoverageReports, type CoverageSourceMap, type NodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "./values.mjs";
export interface MeasuredScript {
  code: string;
  included: Set<string>;
  url: string;
  executions: { result: Profiler.ScriptCoverage[] }[];
  sourceType: "script" | "module";
  map?: CoverageSourceMap;
}

export function recordExecution(measured: MeasuredScript, script: NodeCoverageReport["result"][number]) {
  measured.executions.push({
    result: [{ ...script, scriptId: script.scriptId ?? script.url, url: measured.url }],
  });
  // Raw reports repeatedly contain the same large bundles. Bound retained ranges
  // while preserving the V8 merger's block-coverage precedence and execution counts.
  if (measured.executions.length === 32) measured.executions = [mergeProcessCovs(measured.executions)];
}

export const mapIdentity = (map: CoverageSourceMap, url: string) =>
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
export interface ScannedCoverage {
  bundles: { url: string; executions: MeasuredScript["executions"] }[];
  helpers: MeasuredScript[];
}
/** Every report is validated; source maps must match the frozen checkout before attribution. */
export function scanCoverageReports(
  directory: string,
  root: string,
  candidates: MeasuredScript[],
  files: string[],
): ScannedCoverage {
  const bundles = new Map<string, MeasuredScript[]>();
  const helpers = new Map<string, MeasuredScript>();
  for (const candidate of candidates) {
    const key = mapIdentity(required(candidate.map, "Missing bundle map"), candidate.url);
    const entries = bundles.get(key) ?? [];
    entries.push(candidate);
    bundles.set(key, entries);
  }
  for (const data of readNodeCoverageReports(directory, files)) {
    for (const script of data.result) {
      const map = data["source-map-cache"]?.[script.url]?.data;
      if (map) {
        if (!script.url.startsWith("file:")) continue;
        // Index by portable identity, then compare every attributed map field exactly.
        // Re-serializing and hashing repeated multi-megabyte maps creates avoidable garbage.
        const candidates = (bundles.get(mapIdentity(map, script.url)) ?? []).filter(
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

  const compact = (script: MeasuredScript) => {
    script.executions = [mergeProcessCovs(script.executions)];
    return script;
  };
  return {
    bundles: candidates
      .filter((script) => script.executions.length)
      .map((script) => ({ url: script.url, executions: compact(script).executions })),
    helpers: [...helpers.values()].map(compact),
  };
}
/** Convert one independent script; the caller controls CPU admission. */
export async function convertCoverageScript(bundle: MeasuredScript): Promise<Record<string, FileCoverageData>> {
  const merged = mergeProcessCovs(bundle.executions);
  bundle.executions.length = 0;
  if (!merged.result.length) return {};
  const converted = await convert({
    code: bundle.code,
    ast: parse(bundle.code, { ecmaVersion: "latest", locations: true, sourceType: bundle.sourceType }),
    wrapperLength: 0,
    coverage: required(merged.result[0], "Merged coverage must retain its script"),
    ...(bundle.map ? { sourceMap: bundle.map } : {}),
    // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
    ignoreSourceCode: (code) => code.trim() === "export",
  });
  return Object.fromEntries(
    Object.entries(converted).flatMap(([path, value]) => {
      const absolute = resolve(path);
      return bundle.included.has(absolute)
        ? [[absolute, { ...coverage.createFileCoverage(value).data, path: absolute }]]
        : [];
    }),
  );
}
