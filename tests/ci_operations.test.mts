import { expect, test } from "vitest";
import { assertOperationCoverage, CIOperation, nativeCIJobs } from "../scripts/ci-operations.mjs";
import { readCITargets } from "../scripts/ci-contract.mjs";

function catalog() {
  const native = (id: string, path: string, profile?: string) => ({
    id,
    path,
    kind: "native",
    os: "linux",
    architecture: "x64",
    environment: "native",
    checks: [],
    release: profile === undefined,
    integration: profile === undefined && path === ".",
    ...(profile ? { toolchain: profile } : {}),
    phases: [
      "native-install",
      "native-check",
      ...(profile === undefined && path === "." ? ["integration"] : []),
      ...(profile === undefined ? ["release"] : []),
    ],
  });
  return readCITargets([
    native("root", "."),
    native("library", "library"),
    native("root-other-runtime", ".", "other-runtime"),
    native("library-other-runtime", "library", "other-runtime"),
    {
      id: "older-python",
      path: "library",
      kind: "compatibility",
      os: "linux",
      architecture: "x64",
      environment: "native",
      checks: [],
      release: false,
      runtime: "python",
      version: "3.13.0",
      roles: ["test"],
      phases: ["python"],
    },
  ]);
}

test("operation jobs retain complete profiles and account for every configured phase once", () => {
  const targets = catalog(),
    jobs = nativeCIJobs(targets, "linux", "x64");
  assertOperationCoverage(targets, jobs);
  const checks = jobs.filter((job) => job.operation === CIOperation.Checks);
  expect(checks.map((job) => job.targets.map((target) => target.id))).toEqual([
    ["root", "library"],
    ["root-other-runtime", "library-other-runtime"],
    ["older-python"],
  ]);
  expect(jobs.find((job) => job.operation === CIOperation.Integration)?.targets.map((target) => target.id)).toEqual([
    "root",
  ]);
  expect(jobs.find((job) => job.operation === CIOperation.Release)?.targets.map((target) => target.id)).toEqual([
    "root",
    "library",
  ]);
  expect(new Set(jobs.map((job) => job.artifact)).size).toBe(jobs.length);
});

test("missing, duplicated, and unexpected work cannot satisfy the operation plan", () => {
  const targets = catalog(),
    jobs = nativeCIJobs(targets, "linux", "x64");
  expect(() => {
    assertOperationCoverage(targets, jobs.slice(1));
  }).toThrow(/exactly once/);
  expect(() => {
    assertOperationCoverage(targets, [...jobs, ...jobs]);
  }).toThrow(/exactly once/);
  expect(() => {
    assertOperationCoverage(targets.slice(1), jobs);
  }).toThrow(/exactly once/);
  expect(() => nativeCIJobs([...targets, ...targets], "linux", "x64")).toThrow(/unique targets/);
  expect(() => nativeCIJobs(targets, "windows", "arm64")).toThrow(/nonempty/);
});
