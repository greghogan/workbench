import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { traceCoverageProducers } from "./fixtures/coverage-producers.mts";
import { nodeCoverageProducer, InvalidNodeCoverageReport } from "../scripts/node-coverage-reports.mjs";
import { required } from "../src/invariants.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("coverage diagnostics identify owning tests and completed child processes and workers without arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-coverage-producers-"));
  roots.push(root);
  const raw = join(root, "raw");
  const stop = traceCoverageProducers(raw, () => ({ testPath: "fixture.test.mts", currentTestName: "owns execution" }));
  try {
    const child = spawn(process.execPath, ["-e", "void 0", "PRIVATE_ARGUMENT"], {
      env: { ...process.env, NODE_V8_COVERAGE: "" },
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        resolve();
      });
    });
    const processReport = nodeCoverageProducer(
      raw,
      new InvalidNodeCoverageReport(
        `coverage-${String(required(child.pid, "Child PID"))}-123-0.json`,
        0,
        "invalid-json",
      ).diagnostic,
    );
    expect(processReport).toMatchObject({
      process: { testPath: "fixture.test.mts", currentTestName: "owns execution", status: 0 },
    });
    expect(JSON.stringify(processReport)).not.toContain("PRIVATE_ARGUMENT");
    const worker = new Worker("void 0", { eval: true, env: { ...process.env, NODE_V8_COVERAGE: "" } });
    const thread = worker.threadId;
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", () => {
        resolve();
      });
    });
    expect(
      nodeCoverageProducer(
        raw,
        new InvalidNodeCoverageReport(`coverage-${String(process.pid)}-123-${String(thread)}.json`, 0, "invalid-json")
          .diagnostic,
      ),
    ).toMatchObject({ worker: { thread, testPath: "fixture.test.mts", status: 0 } });
  } finally {
    stop();
  }
});
test("missing producer evidence preserves the primary coverage diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-coverage-producers-missing-"));
  roots.push(root);
  expect(
    nodeCoverageProducer(root, new InvalidNodeCoverageReport("coverage-123-456-7.json", 0, "invalid-json").diagnostic),
  ).toBeUndefined();
});
