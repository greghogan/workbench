import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import type { Profiler } from "node:inspector";
import { build } from "esbuild";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { coverageConcurrency, subprocessCoverage } from "../../../../scripts/test-coverage.mjs";
import { coverageJobs } from "../../../../scripts/coverage-workers.mjs";
import {
  collectedScriptCoverage,
  convertCoverageScript,
  CoverageAccumulator,
  CoverageSources,
  type MeasuredScript,
} from "../../../../scripts/coverage-processing.mjs";
import { InvalidNodeCoverageReport } from "../../../../scripts/node-coverage-reports.mjs";
const temporary: string[] = [];
function conversionJob(url = "file:///fixture.mjs") {
  return {
    kind: "convert" as const,
    script: { url, code: "", included: new Set<string>(), sourceType: "script" as const },
    execution: { url, scriptId: "0", functions: [] },
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("bounded coverage workers preserve serial counters across repeated reports and independent scripts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-coverage-workers-")));
  temporary.push(root);
  const raw = join(root, "raw");
  mkdirSync(raw);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  const contents = "export function used() {return 42;}\nexport function never() {return 0;}\nconsole.log(used());\n";
  writeFileSync(join(root, "src/mapped.ts"), contents);
  await build({
    entryPoints: [join(root, "src/mapped.ts")],
    outfile: join(root, "scripts/mapped.mjs"),
    platform: "node",
    format: "esm",
    sourcemap: "inline",
  });
  for (const name of ["one", "two", "mapped"]) {
    const path = join(root, `scripts/${name}.mjs`);
    if (name !== "mapped") writeFileSync(path, contents);
    const before = new Set(readdirSync(raw));
    const result = spawnSync(process.execPath, ["--enable-source-maps", path], {
      env: { ...process.env, NODE_V8_COVERAGE: raw },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const captured = readdirSync(raw).find((file) => !before.has(file));
    assert.ok(captured);
    const bytes = readFileSync(join(raw, captured));
    for (let i = 1; i < 16; i++) writeFileSync(join(raw, `${name}-${String(i)}.json`), bytes);
  }
  vi.stubEnv("WORKBENCH_CPU_BUDGET", "1");
  const serial = await subprocessCoverage(raw, root);
  vi.stubEnv("WORKBENCH_CPU_BUDGET", "4");
  const parallel = await subprocessCoverage(raw, root);
  assert.deepEqual(parallel.toJSON(), serial.toJSON());
  const alias = join(root, "project-alias");
  symlinkSync(root, alias, "junction");
  assert.deepEqual((await subprocessCoverage(raw, alias)).toJSON(), serial.toJSON());
  expect(parallel.files().sort()).toEqual(
    ["scripts/one.mjs", "scripts/two.mjs", "src/mapped.ts"].map((path) => resolve(root, path)),
  );
  for (const path of parallel.files()) {
    const file = parallel.fileCoverageFor(path);
    const counts = Object.entries(file.fnMap).map(([id, fn]) => ({ name: fn.name, count: file.f[id] }));
    expect(counts).toContainEqual({ name: "used", count: 16 });
    expect(counts).toContainEqual({ name: "never", count: 0 });
  }
  writeFileSync(join(raw, "coverage-123-456-7.json"), '{"PRIVATE SOURCE');
  await expect(subprocessCoverage(raw, root)).rejects.toMatchObject({
    diagnostic: { file: "coverage-123-456-7.json", bytes: 16, pid: 123, thread: 7, reason: "invalid-json" },
  });
  try {
    await subprocessCoverage(raw, root);
    throw new Error("Expected malformed report rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidNodeCoverageReport);
    expect(String(error)).not.toContain("PRIVATE SOURCE");
  }
});

test("coverage worker admission rejects invalid capacity and accepts empty work", async () => {
  await expect(coverageJobs([], { capacity: 0 })).rejects.toThrow("positive integer");
  await expect(coverageJobs([], { capacity: 1 })).resolves.toEqual([]);
});

test("cancellation drains every coverage worker before rejecting", async () => {
  const controller = new AbortController();
  const workers: Worker[] = [];
  const create = () => {
    const worker = new Worker("setInterval(()=>{},1000)", { eval: true });
    workers.push(worker);
    worker.once("online", () => {
      controller.abort();
    });
    return worker;
  };
  const job = conversionJob();
  await expect(
    coverageJobs([job, job], { capacity: 2, createWorker: create, signal: controller.signal }),
  ).rejects.toThrow();
  expect(workers).toHaveLength(2);
  expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
});

test.each([
  { name: "unexpected exit", code: "process.exit(7)", diagnostic: /exited before returning a result \(7\)/ },
  {
    name: "uncaught exception",
    code: "throw new Error('fixture worker crashed')",
    diagnostic: /fixture worker crashed/,
  },
  {
    name: "wrong reply kind",
    code: "port.postMessage({kind:'ready'})",
    diagnostic: /returned ready; expected convert/,
  },
])("coverage owns and drains every worker after $name", async ({ code, diagnostic }) => {
  const exits: Promise<unknown>[] = [];
  const workers: Worker[] = [];
  let exited = 0;
  const create = () => {
    const index = workers.length;
    const worker = new Worker(
      `const {parentPort:port}=require('node:worker_threads'); port.on('message', () => { ${index === 0 ? code : "/* wait for owner termination */"} });`,
      { eval: true },
    );
    workers.push(worker);
    // Resolve on exit even when the worker emits an error first.
    exits.push(
      new Promise((resolve) => {
        worker.once("exit", () => {
          exited++;
          resolve(undefined);
        });
      }),
    );
    return worker;
  };
  const job = conversionJob();
  try {
    await expect(coverageJobs([job, job], { capacity: 2, createWorker: create })).rejects.toThrow(diagnostic);
    expect(exited).toBe(2);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    await Promise.all(exits);
  }
});

test.each([
  { source: "D:/source.ts", rooted: false },
  { source: "D:/space dir/source.ts", rooted: false },
  { source: "../src/source.ts", rooted: false },
  { source: "file:///D:/source.ts", rooted: false },
  { source: "source.ts", rooted: true },
])("coverage preserves source identity for $source (file URL source root: $rooted)", async ({ source, rooted }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-coverage-source-")));
  temporary.push(root);
  const code = "const answer = 42;\n";
  const url = pathToFileURL(join(root, "bundle.cjs")).href;
  const sourceRoot = rooted ? pathToFileURL(join(root, "src")).href + "/" : undefined;
  const path = source.startsWith("file:")
    ? fileURLToPath(source)
    : resolve(sourceRoot ? fileURLToPath(sourceRoot) : root, source);
  const bundle: MeasuredScript = {
    code,
    url,
    sourceType: "script",
    included: new Set([path]),
    map: {
      version: 3,
      sources: [source],
      sourcesContent: [code],
      names: [],
      mappings: "AAAA",
      ...(sourceRoot ? { sourceRoot } : {}),
    },
  };
  const execution = {
    scriptId: "1",
    url,
    functions: [
      {
        functionName: "",
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
      },
    ],
  };
  const map = bundle.map;
  assert.ok(map);
  const candidate = { url, map };
  expect(
    new CoverageSources([candidate]).match(url, { ...map, sourceRoot: "", sources: [pathToFileURL(path).href] }),
  ).toBe(candidate);
  const result = await convertCoverageScript(bundle, execution);
  expect(Object.keys(result)).toEqual([path]);
  expect(Object.values(result[path]?.s ?? {})).toContain(1);
});

test("bundled rendering dependencies cannot prevent measuring executed and unused project TSX", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-render-coverage-")));
  temporary.push(root);
  for (const name of ["src", "bundle", "scripts", "raw"]) mkdirSync(join(root, name));
  const source = join(root, "src/main.tsx");
  writeFileSync(
    source,
    'import {renderToString} from "preact-render-to-string";\n' +
      'export function render(value: boolean) { return renderToString(<p>{value ? "Yes" : "No"}</p>); }\n' +
      "export function never() { return renderToString(<p>Unused</p>); }\n" +
      "console.log(render(true));\n",
  );
  await build({
    absWorkingDir: root,
    entryPoints: [source],
    outfile: join(root, "bundle/main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "preact",
    nodePaths: [realpathSync(resolve("node_modules"))],
  });
  const helper = join(root, "scripts/helper.mjs");
  writeFileSync(helper, "console.log('independent helper');\n");
  for (const path of [join(root, "bundle/main.cjs"), helper]) {
    const child = spawnSync(process.execPath, ["--enable-source-maps", path], {
      env: { ...process.env, NODE_V8_COVERAGE: join(root, "raw") },
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);
  }
  vi.stubEnv("WORKBENCH_CPU_BUDGET", "1");
  const serial = await subprocessCoverage(join(root, "raw"), root);
  vi.stubEnv("WORKBENCH_CPU_BUDGET", "4");
  const parallel = await subprocessCoverage(join(root, "raw"), root);
  expect(parallel.toJSON()).toEqual(serial.toJSON());
  expect(parallel.files().sort()).toEqual([helper, source].sort());
  const file = parallel.fileCoverageFor(source);
  const functions = Object.entries(file.fnMap).map(([id, fn]) => ({ name: fn.name, count: file.f[id] }));
  expect(functions).toContainEqual({ name: "render", count: 1 });
  expect(functions).toContainEqual({ name: "never", count: 0 });
  expect(file.getLineCoverage()).toMatchObject({ 2: 1, 3: 0 });
});

test("idle coverage workers claim the next job without waiting for earlier jobs", async () => {
  const { EventEmitter } = await import("node:events");
  class ControlledWorker extends EventEmitter {
    requests: unknown[] = [];
    postMessage(request: unknown) {
      this.requests.push(request);
    }
    terminate() {
      this.emit("exit", 0);
      return Promise.resolve(0);
    }
  }
  const workers: ControlledWorker[] = [];
  let acquired = 0,
    released = 0;
  const jobs = ["slow", "fast", "next"].map((name) => conversionJob("file:///" + name + ".mjs"));
  const result = coverageJobs(jobs, {
    capacity: 2,
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    admission: {
      acquire: () => {
        acquired++;
        return Promise.resolve({
          release: () => {
            released++;
          },
        });
      },
    },
  });
  await vi.waitFor(() => {
    expect(acquired).toBe(2);
    expect(workers[0]?.requests).toEqual([jobs[0]]);
    expect(workers[1]?.requests).toEqual([jobs[1]]);
  });
  workers[1]?.emit("message", { kind: "convert", result: {} });
  await vi.waitFor(() => {
    expect(workers[1]?.requests).toEqual([jobs[1], jobs[2]]);
  });
  expect(workers[0]?.requests).toEqual([jobs[0]]);
  workers[1]?.emit("message", { kind: "convert", result: {} });
  workers[0]?.emit("message", { kind: "convert", result: {} });
  await expect(result).resolves.toEqual([{}, {}, {}]);
  expect(released).toBe(3);
});

test("range aggregation agrees with V8 for repeated, overlapping, and mixed-granularity reports", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-coverage-layouts-"));
  temporary.push(root);
  mkdirSync(join(root, "scripts"));
  const helper = join(root, "scripts/helper.mjs");
  writeFileSync(helper, "export {};");
  const url = pathToFileURL(helper).href;
  const fn = (
    functionName: string,
    isBlockCoverage: boolean,
    ranges: [number, number, number][],
  ): Profiler.FunctionCoverage => ({
    functionName,
    isBlockCoverage,
    ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })),
  });
  const reports = Array.from({ length: 60 }, (_, index) => ({
    result: [
      {
        url,
        scriptId: "0",
        functions: [
          fn("matching", true, [
            [0, 50, 2],
            [8, 30, index % 3],
            [18, 22, 0],
          ]),
          fn("unexecuted", true, [[50, 60, 0]]),
          index % 2
            ? fn("mixed", false, [[60, 100, 100]])
            : fn("mixed", true, [
                [60, 100, 2],
                [65, 80, 0],
              ]),
          fn("overlap", true, [
            [100, 200, 2],
            [110 + (index % 12), 130 + (index % 12), 0],
          ]),
        ],
      },
    ],
  }));
  const reference = mergeProcessCovs(structuredClone(reports)).result[0]?.functions;
  for (const capacity of [1, 4]) {
    const combined = new CoverageAccumulator(root, []);
    for (let worker = 0; worker < capacity; worker++) {
      const local = new CoverageAccumulator(root, []);
      for (const [index, report] of structuredClone(reports).entries())
        if (index % capacity === worker) local.add(report);
      combined.merge(local.result());
    }
    const result = combined.result().helpers[0];
    assert.ok(result);
    assert.deepEqual(collectedScriptCoverage(result).functions, reference);
  }
});

test("coverage capacity respects both available processors and memory without hiding all work", () => {
  for (const cpus of [1, 2, 8, 32])
    for (const memory of [0, 1024 ** 3, 8 * 1024 ** 3, 128 * 1024 ** 3]) {
      const capacity = coverageConcurrency(cpus, memory);
      expect(capacity).toBeGreaterThanOrEqual(1);
      expect(capacity).toBeLessThanOrEqual(cpus);
      expect(coverageConcurrency(cpus, memory * 2)).toBeGreaterThanOrEqual(capacity);
    }
});
