import { isMainScript } from "./script-entry.mjs";
import { opendirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { readBoundedFile } from "../src/file-reads.ts";
import { record, records, string } from "./values.mjs";

const diagnostic = (value: string) =>
  stripVTControlCharacters(value)
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 2000);
const resultKinds = ["fail", "review", "pass", "open", "informational", "notApplicable"] as const;
const levels = ["error", "warning", "note", "none"] as const;
export interface SecurityFinding {
  tool: string;
  rule: string;
  message: string;
  path?: string;
  line?: number;
}
function location(result: Record<string, unknown>): Pick<SecurityFinding, "path" | "line"> {
  if (result.locations === undefined) return {};
  const first = records(result.locations, "Invalid finding locations")[0];
  if (first?.physicalLocation === undefined) return {};
  const physical = record(first.physicalLocation, "Invalid physical location");
  const artifact =
    physical.artifactLocation === undefined ? {} : record(physical.artifactLocation, "Invalid artifact location");
  const region = physical.region === undefined ? {} : record(physical.region, "Invalid finding region");
  const path = artifact.uri === undefined ? undefined : diagnostic(string(artifact.uri, "Invalid finding path"));
  const line = region.startLine;
  if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1))
    throw new Error("Invalid finding line");
  return { ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) };
}
/** Normalize only the SARIF contracts used by the security gate; display formatting has no policy authority. */
export function securityFindings(input: unknown): SecurityFinding[] {
  const sarif = record(input, "Invalid SARIF report");
  if (sarif.version !== "2.1.0") throw new Error("Unsupported SARIF report version");
  const runs = records(sarif.runs, "Missing SARIF runs");
  if (!runs.length) throw new Error("Missing SARIF analysis runs");
  return runs.flatMap((run) => {
    const driver = record(record(run.tool, "Missing SARIF tool").driver, "Missing SARIF driver");
    const tool = diagnostic(string(driver.name, "Missing analyzer name"));
    if (!tool.trim()) throw new Error("Missing analyzer name");
    for (const invocation of run.invocations === undefined
      ? []
      : records(run.invocations, "Invalid analyzer invocations")) {
      if (invocation.executionSuccessful !== undefined && typeof invocation.executionSuccessful !== "boolean")
        throw new Error("Invalid analyzer execution result");
      if (invocation.executionSuccessful === false) throw new Error(`${tool}: analysis execution failed`);
    }
    if (run.results === undefined) throw new Error(`${tool}: analyzer produced no results field`);
    return records(run.results, "Invalid SARIF results").flatMap((result) => {
      const kind = result.kind === undefined ? "fail" : string(result.kind, "Invalid SARIF result kind");
      if (!resultKinds.some((value) => value === kind)) throw new Error("Invalid SARIF result kind");
      const level = result.level === undefined ? "warning" : string(result.level, "Invalid SARIF finding level");
      if (!levels.some((value) => value === level)) throw new Error("Invalid SARIF finding level");
      const suppressed =
        result.suppressions === undefined ? [] : records(result.suppressions, "Invalid SARIF suppressions");
      for (const value of suppressed) {
        if (value.kind !== "inSource" && value.kind !== "external") throw new Error("Invalid SARIF suppression kind");
        if (
          value.status !== undefined &&
          !["accepted", "underReview", "rejected"].includes(string(value.status, "Invalid suppression status"))
        )
          throw new Error("Invalid SARIF suppression status");
      }
      if (
        !["fail", "review", "open"].includes(kind) ||
        level === "note" ||
        level === "none" ||
        suppressed.some(
          (value) => value.status === "accepted" || (value.kind === "inSource" && value.status === undefined),
        )
      )
        return [];
      const message = record(result.message, "Missing SARIF finding message");
      return [
        {
          tool,
          rule: diagnostic(
            result.ruleId === undefined ? "unidentified rule" : string(result.ruleId, "Invalid rule ID"),
          ),
          message: diagnostic(string(message.text ?? message.markdown, "Missing finding text")),
          ...location(result),
        },
      ];
    });
  });
}
export function formatSecurityFinding(finding: SecurityFinding): string {
  const source = finding.path ? `${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}: ` : "";
  return `${source}${finding.tool}: ${finding.rule}: ${finding.message}`;
}
export function checkSecurityResults(directory: string): void {
  let entries = 0,
    bytes = 0,
    reports = 0;
  const findings: SecurityFinding[] = [];
  function visit(path: string, depth = 0): void {
    if (++entries > 4096 || depth > 16) throw new Error("Analyzer report capacity exceeded");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Analyzer results must not be symlinks");
    if (stat.isDirectory()) {
      const dir = opendirSync(path);
      try {
        for (let child; (child = dir.readSync());) visit(join(path, child.name), depth + 1);
      } finally {
        dir.closeSync();
      }
    } else if (/\.sarif(?:\.json)?$/.test(path)) {
      if (++reports > 64) throw new Error("Analyzer report capacity exceeded");
      const body = readBoundedFile(path, 64 * 1024 * 1024 - bytes, "analyzer report");
      bytes += body.length;
      findings.push(...securityFindings(JSON.parse(body.toString("utf8"))));
    }
  }
  visit(directory);
  if (!reports) throw new Error("No SARIF analysis reports were produced");
  if (findings.length)
    throw new Error(
      `Security analysis found ${String(findings.length)} blocking issue(s):\n${findings.slice(0, 50).map(formatSecurityFinding).join("\n")}`,
    );
  console.log(`Security analysis passed (${String(reports)} SARIF report(s)).`);
}
if (isMainScript(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply the analyzer's SARIF output directory");
  checkSecurityResults(resolve(process.argv[2]));
}
