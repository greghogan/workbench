import { runOwnedChild } from "../scripts/owned-child.mjs";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCoverage } from "../scripts/test-coverage.mjs";
import { InvalidNodeCoverageReport } from "../scripts/node-coverage-reports.mjs";
import { completedProcess } from "./fixtures/process.mjs";
import { required } from "../scripts/values.mjs";

vi.mock("../scripts/owned-child.mjs", async (original) => {
  const actual = await original<typeof import("../scripts/owned-child.mjs")>();
  return { ...actual, runOwnedChild: vi.fn() };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string;
const secondary = {
  diagnostics: new Error("diagnostic disk error"),
  cleanup: new Error("scratch removal error"),
  timings: new Error("timing disk error"),
};
const faults = new Set<keyof typeof secondary>();

beforeEach(() => {
  root = actual.realpathSync(actual.mkdtempSync(join(tmpdir(), "workbench-coverage-failure-")));
  faults.clear();
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
    if (faults.has("diagnostics") && basename(String(path)) === "collection-error.json") throw secondary.diagnostics;
    if (faults.has("timings") && basename(String(path)) === "timings.json") throw secondary.timings;
    actual.writeFileSync(path, ...args);
  });
  vi.mocked(fs.rmSync).mockImplementation((path, ...args) => {
    if (faults.has("cleanup") && dirname(String(path)) === join(root, "build")) throw secondary.cleanup;
    actual.rmSync(path, ...args);
  });
});
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  vi.mocked(fs.rmSync).mockImplementation(actual.rmSync);
  vi.restoreAllMocks();
  actual.rmSync(root, { recursive: true, force: true });
});

function childResult(result: ReturnType<typeof completedProcess>, prepare?: (scratch: string) => void) {
  vi.mocked(spawnSync).mockImplementation((_command, args) =>
    args?.includes("cat-file") ? completedProcess({ status: 128 }) : completedProcess({ stdout: "fixture revision\n" }),
  );
  vi.mocked(runOwnedChild).mockImplementation(() => {
    const scratch = join(
      root,
      "build",
      required(
        actual.readdirSync(join(root, "build")).find((name) => name.startsWith("coverage-")),
        "Coverage scratch",
      ),
    );
    prepare?.(scratch);
    return Promise.resolve(result);
  });
}

function successfulCollection(): string {
  const source = join(root, "src/value.js");
  actual.mkdirSync(join(root, "src"));
  actual.mkdirSync(join(root, "workbench"));
  actual.writeFileSync(source, "export function value() { return 42; }\n");
  actual.writeFileSync(
    join(root, "workbench/quality.json"),
    JSON.stringify({ coverage: { lines: 0, statements: 0, functions: 0, branches: 0 } }),
  );
  childResult(completedProcess(), (scratch) => {
    actual.mkdirSync(join(scratch, "raw"));
    actual.mkdirSync(join(scratch, "unit"));
    const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 36 } };
    actual.writeFileSync(
      join(scratch, "unit/coverage-final.json"),
      JSON.stringify({
        [source]: {
          path: source,
          statementMap: { 0: loc },
          fnMap: { 0: { name: "value", decl: loc, loc, line: 1 } },
          branchMap: {},
          s: { 0: 1 },
          f: { 0: 1 },
          b: {},
        },
      }),
    );
  });
  return source;
}

test.each([
  completedProcess({ pid: 123, status: 7 }),
  completedProcess({ pid: 123, status: null, signal: "SIGTERM" }),
  completedProcess({ pid: 0, status: null, error: Object.assign(new Error("spawn refused"), { code: "EAGAIN" }) }),
])("outer coverage failures retain their child outcome %#", async (result) => {
  childResult(result);
  await expect(runCoverage(root)).rejects.toMatchObject({
    message: expect.stringContaining(
      `pid=${String(result.pid)}, status=${String(result.status)}, signal=${String(result.signal)}`,
    ) as unknown,
    ...(result.error ? { cause: result.error } : {}),
  });
  expect(actual.readdirSync(join(root, "build"))).toEqual([]);
  expect(actual.existsSync(join(root, "coverage/timings.json"))).toBe(true);
});

test("failed result retention preserves an earlier child failure", async () => {
  childResult(completedProcess({ status: null, signal: "SIGTERM" }), () => {
    actual.writeFileSync(join(root, "coverage/tests.json"), "{broken");
  });
  const failure: unknown = await runCoverage(root).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected combined failure");
  const errors: unknown[] = failure.errors;
  expect(errors[0]).toMatchObject({ message: expect.stringContaining("signal=SIGTERM") as unknown });
  expect(errors[1]).toBeInstanceOf(SyntaxError);
});

test("diagnostic, cleanup and timing failures preserve the primary collection error and attempt all finalization", async () => {
  childResult(completedProcess(), (scratch) => {
    actual.mkdirSync(join(scratch, "raw"));
    actual.writeFileSync(join(scratch, "raw/coverage-123-456-7.json"), '{"PRIVATE SOURCE');
  });
  for (const key of ["diagnostics", "cleanup", "timings"] as const) faults.add(key);
  const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure: unknown = await runCoverage(root).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected combined failure");
  const errors: unknown[] = failure.errors;
  expect(errors[0]).toBeInstanceOf(InvalidNodeCoverageReport);
  expect(failure.cause).toBe(errors[0]);
  expect(
    errors.slice(1).map((error) => {
      if (!(error instanceof Error)) throw new Error("Expected secondary error");
      return error.cause;
    }),
  ).toEqual([secondary.diagnostics, secondary.cleanup, secondary.timings]);
  expect(failure.message).not.toContain("PRIVATE SOURCE");
  expect(warning).toHaveBeenCalledWith("Coverage timings could not be written.");
});

test("scratch cleanup failure is reported even after successful collection", async () => {
  successfulCollection();
  faults.add("cleanup");
  await expect(runCoverage(root)).rejects.toMatchObject({
    message: "Coverage scratch cleanup failed",
    cause: secondary.cleanup,
  });
  expect(actual.existsSync(join(root, "coverage/timings.json"))).toBe(true);
});

test("observational timing-write failure preserves successful coverage", async () => {
  const source = successfulCollection();
  faults.add("timings");
  const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect((await runCoverage(root)).files()).toEqual([source]);
  expect(actual.readdirSync(join(root, "build"))).toEqual([]);
  expect(warning).toHaveBeenCalledWith("Coverage timings could not be written.");
});
