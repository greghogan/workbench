import { isDeepStrictEqual } from "node:util";
import { parse } from "acorn";
import convert from "ast-v8-to-istanbul";
import { compareFunctionCovs, mergeFunctionCovs } from "@bcoe/v8-coverage";
import coverage from "istanbul-lib-coverage";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Profiler } from "node:inspector";
import type { FileCoverageData, Range } from "istanbul-lib-coverage";
import { type CoverageSourceMap, type NodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "../app/src/core/runtime/values.mjs";
export interface MeasuredScript {
  code: string;
  included: Set<string>;
  url: string;
  sourceType: "script" | "module";
  map?: CoverageSourceMap;
  mapReference?: string;
}

export type CoverageCandidate = Readonly<Pick<MeasuredScript, "url" | "map" | "mapReference">>;
interface CountedFunction {
  coverage: Profiler.FunctionCoverage;
  repeated: boolean;
}
interface RangeLayouts {
  first: CountedFunction;
  alternatives?: Map<string, CountedFunction>;
}
interface ExecutionAccumulator {
  url: string;
  functions: Map<string, RangeLayouts>;
}
interface CollectedScript {
  url: string;
  functions: CountedFunction[][];
}

function mergeFunctionLayouts(layouts: readonly CountedFunction[]): Profiler.FunctionCoverage {
  const merged = required(mergeFunctionCovs(layouts.map((layout) => layout.coverage)), "Missing merged coverage");
  // The V8 merger clears block granularity on a repeated function with only a zero-count root.
  if (layouts.length === 1 && layouts[0]?.repeated)
    merged.isBlockCoverage = !(merged.ranges.length === 1 && merged.ranges[0]?.count === 0);
  return merged;
}

function sameLayout(left: Profiler.CoverageRange[], right: Profiler.CoverageRange[]): boolean {
  return (
    left.length === right.length &&
    left.every((range, index) => {
      const other = right[index];
      return range.startOffset === other?.startOffset && range.endOffset === other.endOffset;
    })
  );
}

function recordFunction(measured: ExecutionAccumulator, coverage: Profiler.FunctionCoverage, repeated: boolean) {
  const root = required(coverage.ranges[0], "Missing root coverage range");
  const key = String(root.startOffset) + ":" + String(root.endOffset);
  const layouts = measured.functions.get(key);
  // Block coverage supersedes function-only counts, including when they arrive in another worker.
  if (layouts?.first.coverage.isBlockCoverage && !coverage.isBlockCoverage) return;
  if (!layouts || (coverage.isBlockCoverage && !layouts.first.coverage.isBlockCoverage)) {
    measured.functions.set(key, { first: { coverage, repeated } });
    return;
  }

  let existing: CountedFunction | undefined;
  if (sameLayout(layouts.first.coverage.ranges, coverage.ranges)) existing = layouts.first;
  else {
    // The common layout needs no allocation. Hash additional layouts so lookup stays linear in the ranges.
    const shape = coverage.ranges
      .map(({ startOffset, endOffset }) => String(startOffset) + ":" + String(endOffset))
      .join(";");
    const alternatives = (layouts.alternatives ??= new Map());
    existing = alternatives.get(shape);
    if (!existing) {
      alternatives.set(shape, { coverage, repeated });
      return;
    }
  }

  existing.repeated = true;
  for (const [index, range] of existing.coverage.ranges.entries())
    range.count += required(coverage.ranges[index], "Missing matching coverage range").count;
}

export function collectedScriptCoverage(script: CollectedScript): Profiler.ScriptCoverage {
  return {
    url: script.url,
    scriptId: "0",
    functions: script.functions.map(mergeFunctionLayouts).sort(compareFunctionCovs),
  };
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

export const coverageMapReferencePrefix = "workbench-coverage:";
export function coverageMapReference(map: CoverageSourceMap): string | undefined {
  return typeof map.file === "string" &&
    map.file.startsWith(coverageMapReferencePrefix) &&
    map.mappings === "" &&
    map.sources.length === 0
    ? map.file
    : undefined;
}
export interface ScannedCoverage {
  bundles: CollectedScript[];
  helpers: CollectedScript[];
}

/** Immutable source-map buckets are prepared once per worker. */
export class CoverageSources {
  private readonly buckets = new Map<string, CoverageCandidate[]>();
  constructor(candidates: readonly CoverageCandidate[]) {
    for (const candidate of candidates) {
      const key = candidate.mapReference ?? mapIdentity(required(candidate.map, "Missing bundle map"), candidate.url);
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(candidate);
      this.buckets.set(key, bucket);
    }
  }
  match(url: string, map: CoverageSourceMap): CoverageCandidate | undefined {
    // Coverage builds carry a content reference even when tests copy the executable into a temporary directory.
    const reference = coverageMapReference(map);
    const bucket = this.buckets.get(reference ?? mapIdentity(map, url)) ?? [];
    const candidates = reference
      ? bucket
      : bucket.filter(
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
      functions: new Map<string, RangeLayouts>(),
    }));
    this.byURL = new Map(this.accumulators.map((candidate) => [candidate.url, candidate]));
  }
  merge(scan: ScannedCoverage): void {
    const merge = (destination: ExecutionAccumulator, source: CollectedScript) => {
      for (const layouts of source.functions)
        for (const { coverage, repeated } of layouts) recordFunction(destination, coverage, repeated);
    };
    for (const reported of scan.bundles)
      merge(required(this.byURL.get(reported.url), "Unknown measured bundle"), reported);
    for (const reported of scan.helpers) merge(this.helper(reported.url), reported);
  }
  private helper(url: string): ExecutionAccumulator {
    let helper = this.helpers.get(url);
    if (!helper) {
      helper = { url, functions: new Map() };
      this.helpers.set(url, helper);
    }
    return helper;
  }
  add(data: NodeCoverageReport): void {
    const { sources, byURL, root } = this;
    for (const script of data.result) {
      if (!script.url.startsWith("file:")) continue;
      const map = data["source-map-cache"]?.[script.url]?.data;
      const expectedReference = byURL.get(script.url)?.mapReference;
      if (expectedReference && (!map || coverageMapReference(map) !== expectedReference))
        throw new Error(`${script.url}: measured bundle has a missing or changed coverage map reference`);
      if (map) {
        const selected = sources.match(script.url, map);
        const bundle = selected ? byURL.get(selected.url) : undefined;
        if (!bundle) continue;
        for (const coverage of script.functions) recordFunction(bundle, coverage, false);
        continue;
      }
      const path = fileURLToPath(script.url);
      if (!/^(?:scripts\/.*|bin\/[^/]+)\.(?:js|mjs|cjs)$/.test(relative(root, path).split(sep).join("/"))) continue;
      if (!existsSync(path)) throw new Error(`${path}: measured helper is missing from the checkout`);
      const helper = this.helper(script.url);
      for (const coverage of script.functions) recordFunction(helper, coverage, false);
    }
  }
  result(): ScannedCoverage {
    const collect = (script: ExecutionAccumulator): CollectedScript => ({
      url: script.url,
      functions: [...script.functions.values()].map(({ first, alternatives }) =>
        alternatives ? [first, ...alternatives.values()] : [first],
      ),
    });
    return {
      bundles: this.accumulators.filter((script) => script.functions.size).map(collect),
      helpers: [...this.helpers.values()].map(collect),
    };
  }
}

/** Convert one independent script; the caller controls CPU admission. */
export async function convertCoverageScript(
  bundle: MeasuredScript,
  execution: Profiler.ScriptCoverage,
): Promise<Record<string, FileCoverageData>> {
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
    coverage: execution,
    ...(sourceMap ? { sourceMap } : {}),
    // esbuild's generated export getters map to the `export` keyword, not a source function or statement.
    ignoreSourceCode: (code) => code.trim() === "export",
  }).catch((cause: unknown) => {
    throw new Error(`Coverage conversion failed for ${bundle.url}`, { cause });
  });
  return Object.fromEntries(
    Object.entries(converted).flatMap(([path, value]) => {
      const absolute = resolve(path);
      if (!bundle.included.has(absolute)) return [];
      const data = { ...coverage.createFileCoverage(value).data, path: absolute };
      // The source mapper uses Infinity for end-of-line columns. Vitest's JSON carries those as null.
      // Match its locations before merging the in-memory map so one source range is credited once.
      const normalize = (range: Range) => {
        for (const position of [range.start, range.end]) {
          const location: { column: number | null } = position;
          if (!Number.isFinite(location.column)) location.column = null;
        }
      };
      for (const range of Object.values(data.statementMap)) normalize(range);
      for (const fn of Object.values(data.fnMap)) {
        normalize(fn.decl);
        normalize(fn.loc);
      }
      for (const branch of Object.values(data.branchMap)) {
        normalize(branch.loc);
        for (const range of branch.locations) normalize(range);
      }
      return [[absolute, data]];
    }),
  );
}
