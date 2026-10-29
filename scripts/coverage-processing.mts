import { isDeepStrictEqual } from "node:util";
import { parse } from "acorn";
import convert from "ast-v8-to-istanbul";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import coverage from "istanbul-lib-coverage";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function coverageSourcePaths(map: CoverageSourceMap, url: string): string[] {
  const directory = dirname(fileURLToPath(url));
  const base = map.sourceRoot?.startsWith("file:")
    ? fileURLToPath(map.sourceRoot)
    : resolve(directory, map.sourceRoot ?? "");
  return map.sources.map((source) =>
    source?.startsWith("file:") ? fileURLToPath(source) : resolve(base, source ?? ""),
  );
}

export const mapIdentity = (map: CoverageSourceMap, url: string) =>
  JSON.stringify(
    map.file ??
      coverageSourcePaths(map, url).map((path) =>
        relative(dirname(fileURLToPath(url)), path)
          .split(sep)
          .join("/"),
      ),
  );
export interface ScannedCoverage {
  bundles: { url: string; executions: MeasuredScript["executions"] }[];
  helpers: ExecutionAccumulator[];
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
export class CoverageAccumulator {
  private readonly accumulators;
  private readonly helpers = new Map<string, ExecutionAccumulator>();
  private readonly byURL;
  constructor(
    private readonly root: string,
    candidates: readonly CoverageCandidate[],
    private readonly sources = new CoverageSources(candidates),
  ) {
    this.accumulators = candidates.map((candidate): CoverageCandidate & ExecutionAccumulator => ({
      ...candidate,
      executions: [],
    }));
    this.byURL = new Map(this.accumulators.map((candidate) => [candidate.url, candidate]));
  }
  scan(directory: string, files: string[]): void {
    const { sources, byURL, helpers, root } = this;
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
          helper = { url: script.url, executions: [] };
          helpers.set(path, helper);
        }
        recordExecution(helper, script);
      }
    }
  }
  result(): ScannedCoverage {
    const compact = <T extends ExecutionAccumulator>(script: T): T => {
      script.executions = [mergeProcessCovs(script.executions)];
      return script;
    };
    return {
      bundles: this.accumulators
        .filter((script) => script.executions.length)
        .map((script) => ({ url: script.url, executions: compact(script).executions })),
      helpers: [...this.helpers.values()].map(compact),
    };
  }
}

export function scanCoverageReports(
  directory: string,
  root: string,
  candidates: readonly CoverageCandidate[],
  files: string[],
  sources = new CoverageSources(candidates),
): ScannedCoverage {
  const accumulator = new CoverageAccumulator(root, candidates, sources);
  accumulator.scan(directory, files);
  return accumulator.result();
}
/** Convert one independent script; the caller controls CPU admission. */
export async function convertCoverageScript(bundle: MeasuredScript): Promise<Record<string, FileCoverageData>> {
  const merged = mergeProcessCovs(bundle.executions);
  if (!merged.result.length) return {};
  const sourceMap = bundle.map ? { ...bundle.map } : undefined;
  if (sourceMap) {
    const paths = coverageSourcePaths(sourceMap, bundle.url);
    // Keep project sources relative so source-text filters can find them. Cross-drive sources need
    // file URLs: a bare Windows drive is otherwise interpreted as a URI scheme by the mapper.
    sourceMap.sources = sourceMap.sources.map((source, index) => {
      if (!source) return source;
      const path = required(paths[index], "Missing coverage source path");
      const local = relative(dirname(fileURLToPath(bundle.url)), path);
      return isAbsolute(local) ? pathToFileURL(path).href : "./" + local.split(sep).join("/");
    });
    sourceMap.sourceRoot = "";
    if (sourceMap.sourcesContent)
      sourceMap.sourcesContent = sourceMap.sourcesContent.map((contents, index) => {
        const path = paths[index];
        // Dependencies are already outside `included`. Their maps still route positions, but their text
        // must not enter project source filtering (upstream maps can contain reversed vendor ranges).
        return path && bundle.included.has(path) ? contents : null;
      });
  }
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
