import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readChecks } from "../../../../src/core/execution/checks/check-configuration.ts";
import { nativeWorkerLimit, workerTool } from "../../../../src/core/execution/checks/native-worker-tools.ts";
import { unixWorkerFifoSupported } from "../../../../src/core/execution/checks/unix-jobserver-protocol.ts";
import { stageFixtures } from "../../../fixtures/check-stages.mjs";

const fixture = stageFixtures();

test.runIf(unixWorkerFifoSupported)("explicit GNU Make parallelism keeps command-only admission", () => {
  const { root, config, save } = fixture();
  config.check.push({ name: "Make build", role: "build", path: ".", command: ["make", "-kj2", "all"] });
  save();
  const configured = readChecks(root).find(({ name }) => name === "Make build");
  if (!configured) throw new Error("Missing Make build fixture");
  expect(workerTool(configured)).toBeUndefined();

  const bin = mkdtempSync(join(tmpdir(), "workbench-worker-tools-"));
  try {
    writeFileSync(join(bin, "make"), '#!/bin/sh\nprintf "GNU Make 4.4\\n"\n', { mode: 0o700 });
    const env = { PATH: bin, WORKBENCH_CPU_BUDGET: "1" };
    expect(nativeWorkerLimit("make", env)).toBe(1);
    expect(nativeWorkerLimit("make", { ...env, GNUMAKEFLAGS: "--jobs=2" })).toBeUndefined();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
