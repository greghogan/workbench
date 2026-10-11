import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parseCIWorkerRequest } from "../scripts/ci-worker-request.mjs";
import { targetPhases } from "../scripts/ci-contract.mjs";

function request(selection = { kind: "native", release: false, environment: "native" }) {
  const target = { id: "fixture", path: ".", os: "linux", architecture: "x64", checks: [], ...selection };
  target.phases = targetPhases(target);
  const workspace = resolve(tmpdir(), "request-workspace");
  return {
    version: 1,
    workspace,
    distribution: workspace,
    target,
    reports: resolve(tmpdir(), "request-reports"),
    image: "fixture-image",
    cache: resolve(tmpdir(), "request-cache"),
    adapter: resolve(tmpdir(), "request-docker"),
    uid: 0,
    gid: 0,
    shared: { WORKBENCH_CPUS: "4" },
  };
}

test("worker requests validate complete native, compatibility, and managed execution contracts", () => {
  for (const selection of [
    { kind: "native", environment: "native", release: true },
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
  ]) {
    const value = request(selection);
    if (selection.kind === "environment") delete value.image;
    expect(parseCIWorkerRequest(value)).toEqual(value);
  }
});

test("malformed worker requests are rejected with a useful diagnostic before filesystem or subprocess effects", () => {
  for (const change of [
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.unknown = true;
    },
    (value) => {
      value.workspace = "relative";
    },
    (value) => {
      value.distribution = resolve(value.workspace, "../outside");
    },
    (value) => {
      value.target.path = "../outside";
    },
    (value) => {
      value.target.os = "macos";
    },
    (value) => {
      value.target.phases = ["release"];
    },
    (value) => {
      value.target.environment = "guix";
    },
    (value) => {
      value.target.release = "true";
    },
    (value) => {
      value.target.runtime = "gcc";
    },
    (value) => {
      value.target.checks = [{ name: "check", role: "test", command: [] }];
    },
    (value) => {
      value.target.checks = [{ name: "check", role: "test", command: ["node"], unexpected: true }];
    },
    (value) => {
      delete value.image;
    },
    (value) => {
      value.uid = -1;
    },
    (value) => {
      value.gid = 1.5;
    },
    (value) => {
      value.shared.WORKBENCH_CPUS = "0";
    },
    (value) => {
      value.shared.BAD = "nul\0value";
    },
    (value) => {
      value.shared["invalid-name"] = "bad";
    },
  ]) {
    const value = request();
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
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/ci-linux/job.mjs"), input], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid local CI worker request: target.path");
    expect(existsSync(value.reports)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
