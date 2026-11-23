import { required } from "../../../../src/core/runtime/invariants.ts";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { readHostedPlan } from "../../../../../scripts/ci-plan-contract.mts";
import { aggregateCI } from "../../../../../scripts/ci-status.mts";
import { ciMatrix } from "../../../../src/core/execution/ci/ci.ts";
import { groupedCIMatrix, ciTargets } from "../../../../src/core/execution/ci/ci-targets.ts";
import { ciPackageMatrix, plannedCIPackages } from "../../../../src/core/execution/ci/ci-packages.ts";
import { ciJobGroups } from "../../../../src/core/execution/ci/ci-job-plan.ts";
import { offlineProfile } from "../../../../src/core/artifacts/offline-profiles.ts";

interface PlanInput {
  native: { include: ((Record<string, unknown> & { paths: string[] }) | null)[] };
  environments: { include: Record<string, unknown>[] };
}
const root = resolve(import.meta.dirname, "../../../../..");
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
      architecture: "x64",
      runner: "ubuntu-26.04",
      paths: ["."],
      selections: [{ path: ".", environment: "nix", node: "26.11.1", architecture: "x64", runner: "ubuntu-26.04" }],
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

test("Workbench's Linux check groups use toolchain-only OCI images on both architectures", () => {
  const selections = new Set<string>();
  for (const { os, architecture, environment, profile } of ciJobGroups(root)) {
    if (os !== "linux" || !profile) continue;
    expect(offlineProfile(root, profile).offline.kind).toBe("toolchain");
    selections.add(`${environment}/${architecture}`);
  }
  expect([...selections].sort()).toEqual([
    "guix/arm64",
    "guix/x64",
    "native/arm64",
    "native/x64",
    "nix/arm64",
    "nix/x64",
  ]);
});

test("reference package jobs include each catalog variant once on its native target", () => {
  const plan = groupedCIMatrix(ciMatrix(root));
  const packages = ciPackageMatrix(root, plan.native.include);
  expect(readHostedPlan({ ...plan, packages }).packages).toEqual(packages);
  expect(packages.include.flatMap((job) => job.packages).sort()).toEqual(
    plannedCIPackages(root)
      .selected.map(({ id }) => id)
      .sort(),
  );
  expect(
    packages.include
      .filter(({ abi }) => abi === "musl")
      .map(({ architecture }) => architecture)
      .sort(),
  ).toEqual(["arm64", "x64"]);
  const go = required(
    packages.include.find(({ id }) => id === "workbench-go.linux-x64.guix"),
    "Guix Go packages",
  );
  expect(go.paths).toEqual(["examples/languages/go"]);
  expect(go.packages.filter((id) => id.split(".")[2] === "squashfs")).toEqual([
    "go-guix-squashfs.linux-x64.squashfs.go-guix-squashfs",
  ]);
  expect(() => readHostedPlan({ ...plan, packages: { ...packages, include: [...packages.include, go] } })).toThrow(
    /duplicates/,
  );
  expect(aggregateCI({}, { ...plan, packages })).toContain("release-packages: missing (expected success)");
  expect(
    aggregateCI({ "release-packages": { result: "skipped" } }, { ...plan, packages: { ...packages, include: [] } }),
  ).not.toContain("release-packages: skipped (expected success)");
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
      delete required(value.environments.include[0], "Managed job").architecture;
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
