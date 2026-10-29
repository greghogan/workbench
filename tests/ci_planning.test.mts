import { required } from "../src/invariants.ts";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { readHostedPlan } from "../scripts/ci-plan-contract.mts";
import { aggregateCI } from "../scripts/ci-status.mts";
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
    candidate: { result: "success" },
    security: { result: "success" },
    engineering: { result: "success" },
    native: { result: "success" },
    environments: { result: "skipped" },
    devcontainer: { result: "skipped" },
  };
  expect(aggregateCI(needs, plan)).toEqual([]);
  expect(aggregateCI({ ...needs, security: { result: "failure" } }, plan)).toEqual([
    "security: failure (expected success)",
  ]);
  expect(aggregateCI({ ...needs, "screen-reader": { result: "failure" } }, plan)).toEqual([
    "screen-reader: failure (expected success)",
  ]);
  expect(
    aggregateCI({ ...needs, "screen-reader": { result: "success" }, "rust-portable": { result: "cancelled" } }, plan),
  ).toEqual(["rust-portable: cancelled (expected success)"]);
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
test("hosted grouping preserves every configured target and its selected roots", () => {
  const matrix = ciMatrix(root);
  const plan = groupedCIMatrix(matrix);
  expect(readHostedPlan(plan)).toBe(plan);
  for (const [groups, entries] of [
    [plan.native.include, matrix.native.include],
    [plan.compatibility.include, matrix.compatibility.include],
    [plan.environments.include, matrix.environments.include],
  ] as const) {
    const selected = groups.flatMap<{ path: string }>((group) => group.selections);
    expect(selected.map((entry) => JSON.stringify(entry)).sort()).toEqual(
      entries.map((entry) => JSON.stringify(entry)).sort(),
    );
    for (const group of groups) {
      const paths = new Set(group.selections.map((entry) => entry.path));
      expect(new Set(group.paths)).toEqual(paths);
      expect(group.paths.length).toBe(paths.size);
    }
  }
  for (const group of plan.native.include)
    for (const selection of group.selections) {
      expect(selection.os).toBe(group.os);
      expect(selection.architecture).toBe(group.architecture);
      expect(selection.runner).toBe(group.runner);
    }
  const targets = ciTargets(root);
  expect(targets.length).toBeGreaterThan(0);
  expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
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
