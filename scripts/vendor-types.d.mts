/** The pinned upstream package exposes this API without publishing TypeScript declarations. */
declare module "@bcoe/v8-coverage" {
  import type { Profiler } from "node:inspector";
  export function mergeProcessCovs(coverages: { result: Profiler.ScriptCoverage[] }[]): {
    result: Profiler.ScriptCoverage[];
  };
  export function compareFunctionCovs(left: Profiler.FunctionCoverage, right: Profiler.FunctionCoverage): number;
  export function mergeFunctionCovs(coverages: Profiler.FunctionCoverage[]): Profiler.FunctionCoverage | undefined;
}
