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

export type CoverageCandidate = Readonly<Pick<MeasuredScript, "url" | "map">>;
type ExecutionAccumulator = Pick<MeasuredScript, "url" | "executions">;

export function recordExecution(measured: ExecutionAccumulator, script: NodeCoverageReport["result"][number]) {
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
/** Immutable source-map buckets are prepared once per worker. */
export class CoverageSources {
  private readonly buckets = new Map<string, CoverageCandidate[]>();
  constructor(candidates: readonly CoverageCandidate[]) {
    for (const candidate of candidates) {
      const key = mapIdentity(required(candidate.map, "Missing bundle map"), candidate.url);
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(candidate);
      this.buckets.set(key, bucket);
    }
  }
  match(url: string, map: CoverageSourceMap): CoverageCandidate | undefined {
    const candidates = (this.buckets.get(mapIdentity(map, url)) ?? []).filter(
      (candidate) =>
        map.mappings === candidate.map?.mappings &&
        isDeepStrictEqual(map.names, candidate.map.names) &&
        isDeepStrictEqual(map.sourcesContent, candidate.map.sourcesContent),
    );
    const selected =
      candidates.find((candidate) => candidate.url === url) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selected && candidates.length > 1)
      throw new Error(`${url}: copied coverage source is ambiguous; emit a unique source-map file identity`);
    return selected;
  }
}
/** Every report is validated; source maps must match the frozen checkout before attribution. */
export function scanCoverageReports(
  directory: string,
  root: string,
  candidates: readonly CoverageCandidate[],
  files: string[],
  sources = new CoverageSources(candidates),
): ScannedCoverage {
  const accumulators = candidates.map((candidate): CoverageCandidate & ExecutionAccumulator => ({
    ...candidate,
    executions: [],
  }));
  const helpers = new Map<string, MeasuredScript>();
  const byURL = new Map(accumulators.map((candidate) => [candidate.url, candidate]));
  for (const data of readNodeCoverageReports(directory, files)) {
    for (const script of data.result) {
      const map = data["source-map-cache"]?.[script.url]?.data;
      if (map) {
        if (!script.url.startsWith("file:")) continue;
        const selected = sources.match(script.url, map);
        const bundle = selected ? byURL.get(selected.url) : undefined;
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

  const compact = <T extends ExecutionAccumulator>(script: T): T => {
    script.executions = [mergeProcessCovs(script.executions)];
    return script;
  };
  return {
    bundles: accumulators
      .filter((script) => script.executions.length)
      .map((script) => ({ url: script.url, executions: compact(script).executions })),
    helpers: [...helpers.values()].map(compact),
  };
}
/** Convert one independent script; the caller controls CPU admission. */
export async function convertCoverageScript(bundle: MeasuredScript): Promise<Record<string, FileCoverageData>> {
  const merged = mergeProcessCovs(bundle.executions);
  if (!merged.result.length) return {};
  const sourceMap = bundle.map ? { ...bundle.map } : undefined;
  if (sourceMap?.sourcesContent)
    sourceMap.sourcesContent = sourceMap.sourcesContent.map((contents, index) => {
      const source = sourceMap.sources[index] ?? "";
      const path = source.startsWith("file:")
        ? fileURLToPath(source)
        : resolve(dirname(fileURLToPath(bundle.url)), sourceMap.sourceRoot ?? "", source);
      // Dependencies are already outside `included`. Their maps still route positions, but their text
      // must not enter project source filtering (upstream maps can contain reversed vendor ranges).
      return bundle.included.has(path) ? contents : null;
    });
  const converted = await convert({
    code: bundle.code,
    ast: parse(bundle.code, { ecmaVersion: "latest", locations: true, sourceType: bundle.sourceType }),
    wrapperLength: 0,
    coverage: required(merged.result[0], "Merged coverage must retain its script"),
    ...(sourceMap ? { sourceMap } : {}),
    // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
    ignoreSourceCode: (code) => code.trim() === "export",
  }).catch((cause: unknown) => {
    throw new Error(`Coverage conversion failed for ${bundle.url}`, { cause });
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
