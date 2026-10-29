import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { reportState } from "./ci-reports.mjs";
import { isRecord } from "./values.mjs";
const cell = (value: string): string => value.replace(/[|\r\n<>]/g, " ").slice(0, 200);
/** Advisory evidence is self-contained; no historical runs or timing thresholds are consulted. */
export function browserTimingSummary(value: unknown, target: string): string {
  if (
    !isRecord(value) ||
    value.kind !== "workbench-web-performance" ||
    value.version !== 2 ||
    !isRecord(value.environment) ||
    !isRecord(value.workload) ||
    !isRecord(value.summary)
  )
    throw new Error("invalid browser timing report");
  const environment = value.environment,
    workload = value.workload;
  const text = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("invalid timing metadata");
    return cell(value);
  };
  if (!Number.isSafeInteger(workload.records) || Number(workload.records) < 1) throw new Error("invalid timing corpus");
  const entries = Object.entries(value.summary);
  if (!entries.length || entries.length > 16) throw new Error("invalid browser timing groups");
  const rows = entries.map(([name, entry]) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.count) ||
      Number(entry.count) < 1 ||
      ![entry.medianMs, entry.minMs, entry.maxMs].every(
        (number) => typeof number === "number" && Number.isFinite(number) && number >= 0,
      )
    )
      throw new Error("invalid browser timing samples");
    return `| ${cell(name)} | ${String(entry.count)} | ${Number(entry.medianMs).toFixed(1)} ms | ${Number(entry.minMs).toFixed(1)}–${Number(entry.maxMs).toFixed(1)} ms |`;
  });
  return `\n### Browser timings: ${cell(target)}\n\n${text(environment.platform)}/${text(environment.arch)} · Node ${text(environment.node)} · Chromium ${text(environment.browser)} · ${String(workload.records)} records\n\n| Navigation | Samples | Median | Range |\n| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\nAdvisory measurements from this run; no timing comparison or pass/fail threshold.\n`;
}
export function appendBrowserTimings(reports: string, target: string): void {
  const destination = process.env.GITHUB_STEP_SUMMARY;
  if (!destination) return;
  try {
    for (const name of Object.keys(reportState(reports)).filter((name) => name.endsWith("performance.json"))) {
      const path = join(reports, name);
      if (statSync(path).size > 2 * 1024 * 1024) throw new Error("browser timing report exceeds its size limit");
      appendFileSync(destination, browserTimingSummary(JSON.parse(readFileSync(path, "utf8")) as unknown, target));
    }
  } catch (error) {
    console.error(`Browser timing summary unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
