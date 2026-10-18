import { required } from "../src/invariants.ts";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { readHostedPlan } from "../scripts/ci-plan-contract.mjs";
import { aggregateCI } from "../scripts/ci-status.mjs";
import { ciMatrix } from "../src/ci.ts";
import { groupedCIMatrix, ciTargets } from "../src/ci-targets.ts";

interface PlanInput {
  native: { include: ((Record<string, unknown> & { paths: string[] }) | null)[] };
  environments: { include: Record<string, unknown>[] };
}
const root = resolve(import.meta.dirname, "..");
test("aggregate status accepts only configured empty groups as skipped", () => {
  const plan = groupedCIMatrix(ciMatrix(root));
  plan.environments.include = [];
  const needs = {
    plan: { result: "success" },
    validation: { result: "success" },
    native: { result: "success" },
    environments: { result: "skipped" },
    devcontainer: { result: "skipped" },
  };
  expect(aggregateCI(needs, plan)).toEqual([]);
  for (const result of ["failure", "cancelled", "skipped", undefined])
    expect(aggregateCI({ ...needs, native: result === undefined ? {} : { result } }, plan)).toHaveLength(1);
  plan.environments.include = [
    {
      path: ".",
      environment: "nix",
      node: "26.11.1",
      paths: ["."],
      selections: [{ path: ".", environment: "nix", node: "26.11.1" }],
      msvc: false,
    },
  ];
  expect(aggregateCI(needs, plan)).toEqual(["environments: skipped (expected success)"]);
});
test("all roots share four native jobs, with named tool selections retained within each job", () => {
  const matrix = ciMatrix(root);
  const plan = groupedCIMatrix(matrix);
  expect(readHostedPlan(plan)).toBe(plan);
  expect(plan.native.include.map((entry) => `${entry.os}-${entry.architecture}`)).toEqual([
    "linux-x64",
    "linux-arm64",
    "macos-arm64",
    "windows-x64",
  ]);
  const roots = [...new Set(matrix.native.include.map((entry) => entry.path))];
  for (const job of plan.native.include) {
    expect(job.paths).toEqual(roots);
    expect(
      job.selections.filter((entry) => entry.toolchain?.startsWith("node-")).map((entry) => entry.toolchain),
    ).toEqual(["node-22", "node-24"]);
    expect(job.selections.filter((entry) => entry.toolchain === "gcc")).toHaveLength(job.os === "linux" ? 2 : 0);
  }
  expect(plan.compatibility.include).toEqual([]);
  expect(plan.devcontainer.paths).toEqual([]);
  expect(plan.environments.include.map((job) => job.environment)).toEqual(["guix", "nix"]);
  for (const job of plan.environments.include) expect(job.paths).toEqual(roots);
  const targets = ciTargets(root);
  expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
  expect(
    targets
      .filter((target) => target.kind === "native" && target.toolchain === "gcc")
      .every((target) => target.checks.some((check) => check.role === "lto")),
  ).toBe(true);
});

test("hosted plans reject missing platform data, duplicate roots, and invalid environments before expansion", () => {
  const plan = groupedCIMatrix(ciMatrix(root));
  for (const mutate of [
    (value: PlanInput) => {
      delete required(value.native.include[0], "Native job").runner;
    },
    (value: PlanInput) => {
      required(value.native.include[0], "Native job").paths.push(
        required(required(value.native.include[0], "Native job").paths[0], "Native path"),
      );
    },
    (value: PlanInput) => {
      required(value.environments.include[0], "Expected fixture value: value.environments.include[0]").environment =
        "typo";
    },
    (value: PlanInput) => {
      value.native.include = [null];
    },
  ]) {
    const malformed = structuredClone(plan);
    mutate(malformed);
    expect(() => readHostedPlan(malformed)).toThrow(/Invalid CI plan/);
  }
});
