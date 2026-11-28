import { lstatSync, opendirSync, readdirSync, unlinkSync, type Dir } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import type { Profiler } from "node:inspector";
import type convert from "ast-v8-to-istanbul";
import { errorFrom, isRecord } from "../app/src/core/runtime/values.mjs";
import { readBoundedFile } from "../app/src/core/runtime/file-reads.ts";

export type CoverageSourceMap = NonNullable<Parameters<typeof convert>[0]["sourceMap"]>;
export interface NodeCoverageReport {
  result: (Pick<Profiler.ScriptCoverage, "url" | "functions"> & Partial<Pick<Profiler.ScriptCoverage, "scriptId">>)[];
  "source-map-cache"?: Record<string, { data?: CoverageSourceMap | null }>;
}

// Bound raw allocations independently of the amount of data written across the suite.
const maximumReportBytes = 64 * 1024 ** 2;
const batchBytes = 8 * 1024 ** 2;
const reportFilename = /^coverage-(\d+)-(\d+)-(\d+)\.json$/;

export class InvalidNodeCoverageReport extends Error {
  readonly diagnostic: {
    file: string;
    bytes: number | null;
    pid: number | null;
    thread: number | null;
    reason: string;
  };
  constructor(name: string, bytes: number | null, reason: string) {
    const process = reportFilename.exec(name);
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

/** Node can fail to save shutdown coverage and still exit successfully. */
export function coverageWriteError(directory: string, output: string): InvalidNodeCoverageReport | undefined {
  const normalizedDirectory = directory.replaceAll("\\", "/");
  for (const match of output.matchAll(/(?:^|\n)([A-Z][A-Z0-9_]*): Failed to write file ([^\r\n]+)/g)) {
    const [, code, path] = match;
    if (!code || !path) continue;
    const normalizedPath = path.replaceAll("\\", "/");
    if (!normalizedPath.startsWith(normalizedDirectory + "/")) continue;
    const name = normalizedPath.slice(normalizedDirectory.length + 1);
    if (reportFilename.test(name)) return new InvalidNodeCoverageReport(name, null, "write-failed: " + code);
  }
  return undefined;
}

function validFunction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.functionName === "string" &&
    typeof value.isBlockCoverage === "boolean" &&
    Array.isArray(value.ranges) &&
    value.ranges.length > 0 &&
    value.ranges.every(
      (range: unknown) =>
        isRecord(range) &&
        typeof range.startOffset === "number" &&
        Number.isSafeInteger(range.startOffset) &&
        range.startOffset >= 0 &&
        typeof range.endOffset === "number" &&
        Number.isSafeInteger(range.endOffset) &&
        range.endOffset >= range.startOffset &&
        typeof range.count === "number" &&
        Number.isSafeInteger(range.count) &&
        range.count >= 0,
    )
  );
}

function readNodeCoverageReport(directory: string, name: string) {
  let bytes;
  try {
    const path = join(directory, name);
    const size = lstatSync(path).size;
    if (size > maximumReportBytes) throw new InvalidNodeCoverageReport(name, size, "size-limit");
    bytes = readBoundedFile(path, maximumReportBytes, "Node coverage report");
  } catch (error) {
    if (error instanceof InvalidNodeCoverageReport) throw error;
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
      (script: unknown) =>
        isRecord(script) &&
        typeof script.url === "string" &&
        Array.isArray(script.functions) &&
        script.functions.every(validFunction),
    )
  )
    throw new InvalidNodeCoverageReport(name, bytes.length, "invalid-shape");
  return { report: data as unknown as NodeCoverageReport, bytes: bytes.length };
}

interface CoverageBatch {
  files: string[];
  final: boolean;
  retire: boolean;
}

export interface CoverageCollection {
  count: number;
  bytes: number;
  largestReport: number;
  readMilliseconds: number;
  mergeMilliseconds: number;
  finalDrainMilliseconds: number;
}

export type CoverageBatchResult = Omit<CoverageCollection, "finalDrainMilliseconds"> & { pending: string[] };
export type CoverageReader = (batch: CoverageBatch) => Promise<CoverageBatchResult>;

export function collectNodeCoverageBatch(
  directory: string,
  { files, final, retire }: CoverageBatch,
  consume: (report: NodeCoverageReport) => void,
): CoverageBatchResult {
  const result = {
    count: 0,
    bytes: 0,
    largestReport: 0,
    readMilliseconds: 0,
    mergeMilliseconds: 0,
    pending: [] as string[],
  };
  for (const name of files) {
    const reading = performance.now();
    let input;
    try {
      input = readNodeCoverageReport(directory, name);
    } catch (error) {
      if (final || !(error instanceof InvalidNodeCoverageReport) || error.diagnostic.reason === "size-limit")
        throw error;
      result.pending.push(name);
      continue;
    } finally {
      result.readMilliseconds += performance.now() - reading;
    }
    const merging = performance.now();
    consume(input.report);
    result.mergeMilliseconds += performance.now() - merging;
    if (retire) unlinkSync(join(directory, name));
    result.count++;
    result.bytes += input.bytes;
    result.largestReport = Math.max(result.largestReport, input.bytes);
  }
  return result;
}

/** One directory scan admits bounded batches. Readers own the claimed reports until their merges complete. */
export function drainNodeCoverageReports(
  directory: string,
  readers: readonly CoverageReader[],
  options: { mode?: "collect-and-retire" | "read-once"; signal?: AbortSignal } = {},
) {
  const retire = options.mode !== "read-once";
  const collection: CoverageCollection = {
    count: 0,
    bytes: 0,
    largestReport: 0,
    readMilliseconds: 0,
    mergeMilliseconds: 0,
    finalDrainMilliseconds: 0,
  };
  let active: Promise<void> | undefined;
  let failure: Error | undefined;
  let stopped = false;
  const partial = new Map<string, string>();
  // Each reader owns one batch and parses one report at a time. Divide the normal
  // batch allowance across readers; a single larger report retains its own bound.
  const readerBatchBytes = Math.max(1, Math.floor(batchBytes / readers.length));

  const scan = async (final: boolean) => {
    let directoryScan: Dir | undefined;
    const finalFiles = final ? readdirSync(directory).sort().values() : undefined;
    try {
      if (!final) directoryScan = opendirSync(directory);
      const nextFile = () => (finalFiles ? finalFiles.next().value : directoryScan?.readSync()?.name);
      let exhausted = false;
      const take = () => {
        const files = new Map<string, string>();
        let bytes = 0;
        // Stat work stays bounded even when most entries are unchanged partial writes.
        for (let inspected = 0; !exhausted && inspected < 32 && bytes < readerBatchBytes; inspected++) {
          const name = nextFile();
          if (name === undefined) {
            exhausted = true;
            break;
          }
          if (!name.endsWith(".json")) continue;
          const metadata = lstatSync(join(directory, name), { bigint: true, throwIfNoEntry: false });
          if (!metadata && !final) continue;
          if (metadata && metadata.size > BigInt(maximumReportBytes))
            throw new InvalidNodeCoverageReport(name, Number(metadata.size), "size-limit");
          const identity = metadata ? [metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":") : "";
          if (!final && partial.get(name) === identity) continue;
          files.set(name, identity);
          bytes += Number(metadata?.size ?? 0n);
        }
        return files;
      };
      const results = await Promise.allSettled(
        readers.map(async (read) => {
          try {
            for (;;) {
              if (exhausted || failure || (!final && stopped)) break;
              options.signal?.throwIfAborted();
              const files = take();
              if (files.size) {
                const batch = await read({ files: [...files.keys()], final, retire });
                for (const name of files.keys()) partial.delete(name);
                for (const name of batch.pending) partial.set(name, files.get(name) ?? "");
                collection.count += batch.count;
                collection.bytes += batch.bytes;
                collection.largestReport = Math.max(collection.largestReport, batch.largestReport);
                collection.readMilliseconds += batch.readMilliseconds;
                collection.mergeMilliseconds += batch.mergeMilliseconds;
              }
              await yieldToEvents();
            }
          } catch (error) {
            const reason = errorFrom(error);
            failure ??= reason;
            throw reason;
          }
        }),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw errorFrom(rejected.reason);
    } finally {
      directoryScan?.closeSync();
    }
  };

  const tick = () => {
    if (stopped || active || failure !== undefined || options.signal?.aborted) return;
    active = scan(false)
      .catch((error: unknown) => {
        failure ??= errorFrom(error);
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = retire ? setInterval(tick, 100).unref() : undefined;
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
  let finished: Promise<CoverageCollection> | undefined;
  return {
    stop,
    finish: () => {
      finished ??= (async () => {
        const started = performance.now();
        await stop();
        if (failure !== undefined) throw failure;
        await scan(true);
        collection.finalDrainMilliseconds = performance.now() - started;
        return collection;
      })();
      return finished;
    },
  };
}

/** Preserve only the failing producer's bounded ownership metadata before scratch cleanup. */
export function nodeCoverageProducer(directory: string, diagnostic: InvalidNodeCoverageReport["diagnostic"]): unknown {
  if (diagnostic.pid === null) return undefined;
  const read = (name: string): unknown => {
    try {
      const path = join(`${directory}-producers`, name);
      return JSON.parse(readBoundedFile(path, 65536, "coverage producer diagnostic").toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  };
  const process = read(`process-${String(diagnostic.pid)}.json`);
  const worker = diagnostic.thread
    ? read(`worker-${String(diagnostic.pid)}-${String(diagnostic.thread)}.json`)
    : undefined;
  return process || worker ? { process, worker } : undefined;
}
