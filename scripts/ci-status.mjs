import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { matrixJobGroups, readHostedPlan } from "./ci-plan-contract.mjs";

/** A skipped job is successful only when the planner intentionally produced no work for it. */
export function aggregateCI(needs, matrix) {
  const expected = matrixJobGroups(matrix);
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
    const needs = JSON.parse(environment.WORKBENCH_CI_NEEDS ?? "null");
    if (!needs || typeof needs !== "object" || Array.isArray(needs)) throw new Error("expected job results");
    const encoded = needs.plan?.outputs?.matrix;
    failures = encoded ? aggregateCI(needs, readHostedPlan(JSON.parse(encoded))) : ["plan: no matrix produced"];
  } catch (error) {
    failures = [`CI status input: ${error.message}`];
  }
  for (const failure of failures) console.error(failure);
  if (!failures.length) console.log("All selected checks and validation passed.");
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = statusCI().length ? 1 : 0;
