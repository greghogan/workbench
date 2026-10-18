import { record, string } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
interface JobResult {
  result?: string;
  outputs?: { matrix?: string };
}
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { matrixJobGroups, readHostedPlan } from "./ci-plan-contract.mjs";

/** A skipped job is successful only when the planner intentionally produced no work for it. */
export function aggregateCI(needs: Record<string, JobResult>, matrix: unknown) {
  const expected: Record<string, boolean> = matrixJobGroups(matrix);
  const failures = [];
  for (const name of ["plan", "validation", ...Object.keys(expected)]) {
    const result = needs[name]?.result;
    const wanted = name === "plan" || name === "validation" || expected[name];
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
  for (const failure of failures) console.error(failure);
  if (!failures.length) console.log("Every configured check and validation passed.");
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = statusCI().length ? 1 : 0;
