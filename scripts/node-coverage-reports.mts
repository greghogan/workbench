import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Profiler } from "node:inspector";
import type convert from "ast-v8-to-istanbul";
import { isRecord } from "./values.mjs";

export type CoverageSourceMap = NonNullable<Parameters<typeof convert>[0]["sourceMap"]>;
export interface NodeCoverageReport {
  result: (Pick<Profiler.ScriptCoverage, "url" | "functions"> & Partial<Pick<Profiler.ScriptCoverage, "scriptId">>)[];
  "source-map-cache"?: Record<string, { data?: CoverageSourceMap | null }>;
}

export class InvalidNodeCoverageReport extends Error {
  readonly diagnostic: {
    file: string;
    bytes: number | null;
    pid: number | null;
    thread: number | null;
    reason: string;
  };
  constructor(name: string, bytes: number | null, reason: string) {
    const process = /^coverage-(\d+)-(\d+)-(\d+)\.json$/.exec(name);
    super(`Invalid Node coverage report: ${name} (${String(bytes ?? "unknown")} bytes; ${reason})`);
    this.diagnostic = {
      file: name,
      bytes,
      pid: process ? Number(process[1]) : null,
      thread: process ? Number(process[3]) : null,
      reason,
    };
  }
}

/** Read and validate one report at a time without retaining repeated embedded source maps. */
export function* readNodeCoverageReports(directory: string): Generator<NodeCoverageReport> {
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    let bytes;
    try {
      bytes = readFileSync(join(directory, name));
    } catch {
      throw new InvalidNodeCoverageReport(name, null, "read-failed");
    }
    let data: unknown;
    try {
      data = JSON.parse(bytes.toString("utf8"));
    } catch {
      // JSON parser errors can quote private source contents from an incomplete report.
      throw new InvalidNodeCoverageReport(name, bytes.length, "invalid-json");
    }
    if (
      !isRecord(data) ||
      !Array.isArray(data.result) ||
      !data.result.every(
        (script: unknown) => isRecord(script) && typeof script.url === "string" && Array.isArray(script.functions),
      )
    )
      throw new InvalidNodeCoverageReport(name, bytes.length, "invalid-shape");
    // The nested function and source-map payloads use Node's V8 coverage protocol.
    yield data as unknown as NodeCoverageReport;
  }
}
