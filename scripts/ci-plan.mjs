import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { readHostedPlan } from "./ci-plan-contract.mjs";

/** Event payloads are data; revision values never enter shell source. Unknown events run everything. */
export function comparisonArguments(eventName, event) {
  if (eventName === "workflow_dispatch")
    return event.inputs?.full === false || event.inputs?.full === "false"
      ? event.inputs?.base
        ? ["--affected", "--base", event.inputs.base, "--head", "HEAD"]
        : ["--affected"]
      : ["--full"];
  if (eventName === "pull_request" && event.pull_request?.base?.sha && event.pull_request?.head?.sha)
    return ["--affected", "--base", event.pull_request.base.sha, "--head", event.pull_request.head.sha, "--merge-base"];
  if (eventName === "push" && !event.ref?.startsWith("refs/tags/")) {
    if (event.before && !/^0+$/.test(event.before) && event.after)
      return ["--affected", "--base", event.before, "--head", event.after];
    return ["--affected"];
  }
  return ["--full"];
}

export function selectionSummary(selection) {
  const safe = (value) =>
    String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("|", "&#124;").replaceAll("\n", " ");
  return [
    "## CI root selection",
    "",
    `${safe(selection.mode)}: ${safe(selection.reason)}`,
    "",
    `Comparison: ${safe(selection.base ?? "none")} → ${safe(selection.head)}`,
    `Changed files: ${safe(selection.changedCount ?? "not compared")}`,
    "",
    "| Root | Selected | Reason |",
    "| --- | --- | --- |",
    ...selection.selected.map((entry) => `| ${safe(entry.path)} | yes | ${safe(entry.reasons.join("; "))} |`),
    ...selection.excluded.map((entry) => `| ${safe(entry.path)} | no | ${safe(entry.reason)} |`),
    "",
  ].join("\n");
}

export function planCI(environment = process.env, root = process.cwd()) {
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
  const args = comparisonArguments(environment.GITHUB_EVENT_NAME, event);
  const matrix = readHostedPlan(
    JSON.parse(
      execFileSync(process.execPath, ["bin/workbench.mjs", "checks", "matrix", "--grouped", ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        cwd: root,
        env: environment,
      }),
    ),
  );
  const summary = selectionSummary(matrix.selection);
  console.log(summary);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  if (environment.RUNNER_TEMP)
    writeFileSync(join(environment.RUNNER_TEMP, "workbench-ci-plan.json"), JSON.stringify(matrix) + "\n");
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) planCI();
