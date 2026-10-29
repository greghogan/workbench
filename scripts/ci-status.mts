import { reportCIFailure } from "./ci-errors.mts";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
interface JobResult {
  result?: string;
  outputs?: { matrix?: string };
}
import { matrixJobGroups, readHostedPlan } from "./ci-plan-contract.mts";

/** A skipped job is successful only when the planner intentionally produced no work for it. */
export function aggregateCI(needs: Record<string, JobResult>, matrix: unknown) {
  const expected: Record<string, boolean> = matrixJobGroups(matrix);
  const failures = [];
  for (const name of new Set([
    "plan",
    "validation",
    "candidate",
    "security",
    "engineering",
    ...Object.keys(expected),
    ...Object.keys(needs),
  ])) {
    const result = needs[name]?.result;
    const wanted = !Object.hasOwn(expected, name) || expected[name];
    if (wanted ? result !== "success" : result !== "skipped")
      failures.push(`${name}: ${result ?? "missing"} (expected ${wanted ? "success" : "skipped"})`);
  }
  return failures;
}

export function statusCI(environment = process.env) {
  let failures;
  try {
    const raw = record(JSON.parse(environment.WORKBENCH_CI_NEEDS ?? "null"), "expected job results");
    const needs: Record<string, JobResult> = Object.fromEntries(
      Object.entries(raw).map(([name, value]) => {
        const entry = record(value, "Invalid job result"),
          outputs = entry.outputs === undefined ? undefined : record(entry.outputs, "Invalid job outputs");
        return [
          name,
          {
            ...(entry.result === undefined ? {} : { result: string(entry.result, "Invalid job status") }),
            ...(outputs?.matrix === undefined
              ? {}
              : { outputs: { matrix: string(outputs.matrix, "Invalid matrix output") } }),
          },
        ];
      }),
    );
    const encoded = needs.plan?.outputs?.matrix;
    failures = encoded ? aggregateCI(needs, readHostedPlan(JSON.parse(encoded))) : ["plan: no matrix produced"];
  } catch (error) {
    failures = [`CI status input: ${errorMessage(error)}`];
  }
  for (const failure of failures) reportCIFailure("Required CI job", new Error(failure));
  if (!failures.length) console.log("Every configured check and validation passed.");
  return failures;
}

if (isMainScript(import.meta.url)) process.exitCode = statusCI().length ? 1 : 0;
