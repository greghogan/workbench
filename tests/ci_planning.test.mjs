import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { comparisonArguments } from "../scripts/ci-plan.mjs";
import { aggregateCI, statusCI } from "../scripts/ci-status.mjs";
import { readHostedPlan } from "../scripts/ci-plan-contract.mjs";
import { ciMatrix } from "../src/ci.ts";
import { groupedCIMatrix } from "../src/ci-targets.ts";
import { ciSelection } from "../src/ci-selection.ts";

test("event arguments and aggregate status handle full runs, empty matrices and failures explicitly", () => {
  expect(comparisonArguments("push", { before: "a", after: "b", ref: "refs/heads/main" })).toEqual([
    "--affected",
    "--base",
    "a",
    "--head",
    "b",
  ]);
  expect(comparisonArguments("pull_request", { pull_request: { base: { sha: "a" }, head: { sha: "b" } } })).toEqual([
    "--affected",
    "--base",
    "a",
    "--head",
    "b",
    "--merge-base",
  ]);
  for (const [name, event, expected] of [
    ["push", { before: "0".repeat(40), after: "b" }, ["--affected"]],
    ["push", { ref: "refs/tags/v1" }, ["--full"]],
    ["release", {}, ["--full"]],
    ["workflow_dispatch", { inputs: { full: true } }, ["--full"]],
    ["unknown", {}, ["--full"]],
  ])
    expect(comparisonArguments(name, event)).toEqual(expected);
  expect(comparisonArguments("workflow_dispatch", { inputs: { full: "false", base: "main" } })).toEqual([
    "--affected",
    "--base",
    "main",
    "--head",
    "HEAD",
  ]);
  const matrix = {
    native: { include: [] },
    compatibility: { include: [] },
    environments: { include: [] },
    devcontainer: { paths: [] },
  };
  const needs = {
    plan: { result: "success" },
    validation: { result: "success" },
    ...Object.fromEntries(
      ["native", "compatibility", "environments", "devcontainer"].map((name) => [name, { result: "skipped" }]),
    ),
  };
  expect(aggregateCI(needs, matrix)).toEqual([]);
  matrix.native.include.push({ path: "python" });
  expect(aggregateCI(needs, matrix)).toEqual(["native: skipped (expected success)"]);
  needs.native.result = "failure";
  expect(aggregateCI(needs, matrix)[0]).toContain("failure");
  needs.native.result = "cancelled";
  expect(aggregateCI(needs, matrix)[0]).toContain("cancelled");
  needs.native.result = "success";
  expect(aggregateCI(needs, matrix)).toEqual([]);
  needs.validation.result = "failure";
  expect(aggregateCI(needs, matrix)).toEqual(["validation: failure (expected success)"]);
});

const emptyPlan = () => ({
  native: { include: [] },
  compatibility: { include: [] },
  environments: { include: [] },
  devcontainer: { paths: [] },
  selection: {
    version: 1,
    mode: "affected",
    base: "base",
    head: "head",
    changedCount: 1,
    selected: [],
    excluded: [{ path: "python", reason: "no changed inputs or dependencies" }],
    reason: "compared",
  },
});

test("hosted output rejects malformed plans and reports missing or invalid upstream results", () => {
  const plan = emptyPlan();
  expect(readHostedPlan(plan)).toBe(plan);
  for (const [value, message] of [
    [{ ...plan, native: { include: [null] } }, /native.include/],
    [{ ...plan, devcontainer: { paths: [1] } }, /devcontainer.paths/],
    [{ ...plan, selection: { ...plan.selection, changedCount: -1 } }, /changedCount/],
    [{ ...plan, selection: { ...plan.selection, selected: [{ path: "python", reasons: [1] }] } }, /selected/],
  ])
    expect(() => readHostedPlan(value)).toThrow(message);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(statusCI({ WORKBENCH_CI_NEEDS: "null" })).toEqual(["CI status input: expected job results"]);
    expect(statusCI({ WORKBENCH_CI_NEEDS: JSON.stringify({ plan: { result: "failure" } }) })).toEqual([
      "plan: no matrix produced",
    ]);
    expect(
      statusCI({
        WORKBENCH_CI_NEEDS: JSON.stringify({ plan: { outputs: { matrix: JSON.stringify({ ...plan, native: {} }) } } }),
      }),
    ).toEqual(["CI status input: Invalid CI plan: native.include must contain objects"]);
  } finally {
    error.mockRestore();
  }
});

test("status module imports without effects and direct execution fails on absent input", () => {
  const root = resolve(import.meta.dirname, "..");
  const env = { ...process.env, WORKBENCH_CI_NEEDS: "invalid" };
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./scripts/ci-status.mjs"); console.log(process.exitCode ?? 0)'],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(output.trim()).toBe("0");
  const result = spawnSync(process.execPath, ["scripts/ci-status.mjs"], {
    cwd: root,
    env: { ...env, WORKBENCH_CI_NEEDS: "" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CI status input");
});

test("hosted contracts accept the complete catalog and reject incomplete targets or contradictory explanations", () => {
  const root = resolve(import.meta.dirname, "..");
  const full = { ...groupedCIMatrix(ciMatrix(root)), selection: ciSelection(root, { full: true }) };
  expect(readHostedPlan(full)).toBe(full);
  const active = emptyPlan();
  active.selection.selected = [
    {
      path: "python",
      reasons: ["root input (1 changed file)"],
      matches: [{ reason: "root input (1 changed file)", files: ["python/a.py"] }],
    },
  ];
  active.selection.excluded = [];
  active.selection.changed = ["python/a.py"];
  active.native.include = [
    {
      path: "python",
      paths: ["python"],
      msvc: false,
      os: "linux",
      architecture: "x64",
      runner: "ubuntu-26.04",
      node: "22.23.3",
    },
  ];
  expect(readHostedPlan(active)).toBe(active);
  for (const [mutate, message] of [
    [
      (plan) => {
        delete plan.native.include[0].runner;
      },
      /native.include\[0\].runner/,
    ],
    [
      (plan) => {
        plan.native.include[0].paths = [];
      },
      /paths.*one or more/,
    ],
    [
      (plan) => {
        plan.native.include[0].paths.push("web");
      },
      /web.*not selected/,
    ],
    [
      (plan) => {
        plan.native.include = [];
      },
      /python.*no matrix target/,
    ],
    [
      (plan) => {
        plan.compatibility.include = [
          { path: "python", paths: ["python"], msvc: false, runtime: "unknown", version: "1.0.0" },
        ];
      },
      /runtime is unknown/,
    ],
    [
      (plan) => {
        plan.compatibility.include = [
          { path: "python", paths: ["python"], msvc: false, runtime: "clang", version: "23.1.2" },
        ];
      },
      /roles/,
    ],
    [
      (plan) => {
        plan.environments.include = [
          { path: "python", paths: ["python"], msvc: false, environment: "typo", node: "22.23.3" },
        ];
      },
      /environment is unknown/,
    ],
    [
      (plan) => {
        plan.selection.selected.push(plan.selection.selected[0]);
      },
      /selected paths.*unique/,
    ],
    [
      (plan) => {
        plan.selection.excluded = [{ path: "python", reason: "excluded" }];
      },
      /both selected and excluded/,
    ],
    [
      (plan) => {
        plan.selection.excluded = [
          { path: "web", reason: "excluded" },
          { path: "web", reason: "excluded" },
        ];
      },
      /excluded paths.*unique/,
    ],
    [
      (plan) => {
        plan.selection.changedCount = 2;
      },
      /changedCount differs/,
    ],
    [
      (plan) => {
        plan.selection.changed.push("python/a.py");
        plan.selection.changedCount = 2;
      },
      /changed must not contain duplicates/,
    ],
    [
      (plan) => {
        plan.selection.selected[0].matches[0].files = ["python/other.py"];
      },
      /files must belong to changed/,
    ],
    [
      (plan) => {
        plan.selection.selected[0].matches[0].files.push("python/a.py");
      },
      /match files must not contain duplicates/,
    ],
    [
      (plan) => {
        plan.selection.selected[0].matches[0].reason = "unrelated";
      },
      /match reason must belong/,
    ],
    [
      (plan) => {
        delete plan.selection.changed;
      },
      /matches require changed/,
    ],
    [
      (plan) => {
        plan.selection.mode = "full";
      },
      /full selection must not claim/,
    ],
    [
      (plan) => {
        plan.selection.base = null;
      },
      /affected selection requires a base/,
    ],
    [
      (plan) => {
        plan.selection.failure = { kind: "history", operation: "git show", message: "missing" };
      },
      /failure must describe a fallback/,
    ],
  ]) {
    const malformed = structuredClone(active);
    mutate(malformed);
    expect(() => readHostedPlan(malformed)).toThrow(message);
  }
});
