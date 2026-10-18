import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { afterEach, expect, test, vi } from "vitest";
import { subprocessCoverage } from "../scripts/test-coverage.mjs";
import { coverageJobs } from "../scripts/coverage-workers.mjs";
import { InvalidNodeCoverageReport } from "../scripts/node-coverage-reports.mjs";
const temporary: string[] = [];
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
  for (const name of ["one", "two"]) {
    const path = join(root, `scripts/${name}.mjs`);
    writeFileSync(
      path,
      "export function used() {return 42;}\nexport function never() {return 0;}\nconsole.log(used());\n",
    );
    const before = new Set(readdirSync(raw));
    const result = spawnSync(process.execPath, [path], {
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
  vi.stubEnv("WORKBENCH_CPU_BUDGET", "2");
  const parallel = await subprocessCoverage(raw, root);
  assert.deepEqual(parallel.toJSON(), serial.toJSON());
  const alias = join(root, "project-alias");
  symlinkSync(root, alias, "junction");
  assert.deepEqual((await subprocessCoverage(raw, alias)).toJSON(), serial.toJSON());
  expect(parallel.files().sort()).toEqual(["one", "two"].map((name) => resolve(root, `scripts/${name}.mjs`)));
  for (const path of parallel.files()) {
    const file = parallel.fileCoverageFor(path);
    const counts = Object.entries(file.fnMap).map(([id, fn]) => ({ name: fn.name, count: file.f[id] }));
    expect(counts).toContainEqual({ name: "used", count: 16 });
    expect(counts).toContainEqual({ name: "never", count: 0 });
  }
  writeFileSync(join(raw, "coverage-123-456-7.json"), '{"PRIVATE SOURCE');
  await expect(
    coverageJobs([{ kind: "scan", directory: raw, root, candidates: [], files: ["coverage-123-456-7.json"] }], 1),
  ).rejects.toMatchObject({
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
  await expect(coverageJobs([], 0)).rejects.toThrow("positive integer");
  await expect(coverageJobs([], 1)).resolves.toEqual([]);
});
