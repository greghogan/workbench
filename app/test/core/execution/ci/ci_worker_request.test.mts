import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parseCIWorkerRequest } from "../../../../src/core/execution/ci/support/ci-worker-request.mjs";
import { targetPhases, type TargetSelection } from "../../../../src/core/execution/ci/support/ci-contract.mjs";

interface WorkerInput {
  [key: string]: unknown;
  target: Record<string, unknown>;
  shared: Record<string, unknown>;
  workspace: string;
}
function request(
  selection: TargetSelection & { environment: string } = { kind: "native", release: false, environment: "native" },
) {
  const target = { id: "fixture", path: ".", os: "linux", architecture: "x64", checks: [], ...selection };
  const phases = targetPhases(target);
  const workspace = resolve(tmpdir(), "request-workspace");
  return {
    version: 1,
    workspace,
    distribution: workspace,
    target: { ...target, phases },
    reports: resolve(tmpdir(), "request-reports"),
    image: "fixture-image",
    cache: resolve(tmpdir(), "request-cache"),
    adapter: resolve(tmpdir(), "request-docker"),
    uid: 0,
    gid: 0,
    shared: { WORKBENCH_CPU_BUDGET: "4" },
  };
}

test("worker requests validate complete native, compatibility, and managed execution contracts", () => {
  for (const selection of [
    { kind: "native", environment: "native", release: true },
    { kind: "native", environment: "native", release: false, integration: true },
    { kind: "environment", environment: "guix", release: false },
    { kind: "environment", environment: "nix-docker", release: false },
    { kind: "environment", environment: "devcontainer", release: false },
    {
      kind: "compatibility",
      environment: "native",
      runtime: "gcc",
      version: "16.2.0",
      roles: ["test", "lto"],
      release: false,
    },
    {
      kind: "compatibility",
      environment: "native",
      runtime: "python",
      version: "3.11.17",
      roles: ["test"],
      release: false,
    },
  ] satisfies (TargetSelection & { environment: string })[]) {
    const value = request(selection);
    if (selection.kind === "environment") Reflect.deleteProperty(value, "image");
    expect(parseCIWorkerRequest(value)).toEqual(value);
  }
});

test("malformed worker requests are rejected with a useful diagnostic before filesystem or subprocess effects", () => {
  for (const change of [
    (value: WorkerInput) => {
      value.version = 2;
    },
    (value: WorkerInput) => {
      value.unknown = true;
    },
    (value: WorkerInput) => {
      value.workspace = "relative";
    },
    (value: WorkerInput) => {
      value.distribution = resolve(value.workspace, "../outside");
    },
    (value: WorkerInput) => {
      value.target.path = "../outside";
    },
    (value: WorkerInput) => {
      value.target.os = "macos";
    },
    (value: WorkerInput) => {
      value.target.phases = ["release"];
    },
    (value: WorkerInput) => {
      value.target.environment = "guix";
    },
    (value: WorkerInput) => {
      value.target.release = "true";
    },
    (value: WorkerInput) => {
      value.target.integration = "true";
    },
    (value: WorkerInput) => {
      value.target.runtime = "gcc";
    },
    (value: WorkerInput) => {
      value.target.checks = [{ name: "check", role: "test", command: [] }];
    },
    (value: WorkerInput) => {
      value.target.checks = [{ name: "check", role: "test", command: ["node"], unexpected: true }];
    },
    (value: WorkerInput) => {
      delete value.image;
    },
    (value: WorkerInput) => {
      value.uid = -1;
    },
    (value: WorkerInput) => {
      value.gid = 1.5;
    },
    (value: WorkerInput) => {
      value.shared.WORKBENCH_CPU_BUDGET = "0";
    },
    (value: WorkerInput) => {
      value.shared.WORKBENCH_CPUS = "0";
    },
    (value: WorkerInput) => {
      value.shared.BAD = "nul\0value";
    },
    (value: WorkerInput) => {
      value.shared["invalid-name"] = "bad";
    },
  ]) {
    const value: WorkerInput = request();
    change(value);
    expect(() => parseCIWorkerRequest(value)).toThrow(/Invalid local CI worker request:/);
  }
  const root = mkdtempSync(join(tmpdir(), "workbench-request-rejection-"));
  try {
    const value = request();
    value.reports = join(root, "must-not-be-created");
    value.target.path = "../escape";
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify(value));
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../../../../../scripts/ci-linux/job.mjs"), input],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid local CI worker request: target.path");
    expect(existsSync(value.reports)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local prepared worker preserves a failed operation result and passes its resource allocation", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-prepared-worker-"));
  try {
    const reports = join(root, "reports");
    mkdirSync(join(root, "bin"));
    mkdirSync(reports);
    const value = {
      ...request(),
      profile: "native",
      operation: "checks",
      workspace: root,
      distribution: root,
      reports,
    };
    writeFileSync(
      join(root, "bin/workbench.mjs"),
      `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const args = process.argv.slice(2);
      const option = (name) => args[args.indexOf(name) + 1];
      assert.deepEqual(args.slice(0, 2), ["ci-image-job", "native"]);
      assert.equal(option("--local-image"), "fixture-image");
      assert.equal(option("--operation"), "checks");
      assert.equal(process.env.WORKBENCH_CPU_BUDGET, "4");
      const [target] = JSON.parse(readFileSync(option("--targets"), "utf8"));
      writeFileSync(join(option("--reports"), "job-results.json"), JSON.stringify({
        version: 1,
        targets: [{ id: target.id, success: false, report: "/reports", error: "advisory failed",
          started: "2026-01-01T00:00:00Z", finished: "2026-01-01T00:01:00Z" }],
        errors: [],
      }));
      process.exitCode = 1;
    `,
    );
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify(value));
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../../../../../scripts/ci-linux/job.mjs"), input],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(readFileSync(join(reports, "job-results.json"), "utf8"))).toMatchObject({
      targets: [{ id: "fixture", error: "advisory failed", success: false }],
      errors: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
