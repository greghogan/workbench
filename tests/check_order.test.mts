import { registerProject } from "../src/project-registry.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { readChecks } from "../src/check-configuration.ts";
import { runChecks } from "../src/checks.ts";
import { readConfig } from "../src/project-configuration.ts";
import { planChecks } from "../src/check-plan.ts";
import { checkGroupDependencies } from "../src/check-order.ts";
import { checkExecution } from "../src/check-resources.ts";
import { required } from "../src/invariants.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(ordering: object[]) {
  const root = mkdtempSync(join(tmpdir(), "workbench-check-order-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
  mkdirSync(join(root, "workbench"));
  const paths = [".", "a", "a/child", "b"];
  for (const path of paths) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "demo", path: "." }],
      language_root: paths.map((path) => ({ path, language: "typescript" })),
    }),
  );
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      check: paths.flatMap((path) =>
        ["setup", "test"].map((role) => ({
          path,
          role,
          name: `${path} ${role}`,
          command: [process.execPath, "--version"],
        })),
      ),
    }),
  );
  writeFileSync(join(root, "workbench/automation.toml"), stringify({ check_order: ordering }));
  registerProject(root, "fixture");
  return root;
}

test("explicit setup ordering relaxes only its selected pair and keeps focused roots self-contained", () => {
  const root = fixture([
    { root: "a", after: ".", phase: "setup" },
    { root: "b", after: "a", phase: "complete" },
  ]);
  const checks = readChecks(root);
  const plan = planChecks(root, checks);
  expect(checkGroupDependencies(root, plan.sessions, plan.ordering, plan.automatic)).toEqual([
    [],
    [{ session: 0, phase: "setup" }],
    [
      { session: 0, phase: "complete" },
      { session: 1, phase: "complete" },
    ],
    [
      { session: 0, phase: "complete" },
      { session: 1, phase: "complete" },
    ],
  ]);
  const focused = planChecks(root, checks, { path: "a" });
  expect(focused.sessions).toHaveLength(1);
  expect(focused.sessions[0]?.checks.map((check) => check.role)).toEqual(["setup", "test"]);
  expect(checkGroupDependencies(root, focused.sessions, focused.ordering, focused.automatic)).toEqual([[]]);
  const manual = planChecks(root, checks, { role: ["test"], stage: "commit" });
  expect(checkGroupDependencies(root, manual.sessions, manual.ordering, manual.automatic)[1]).toEqual([
    { session: 0, phase: "complete" },
  ]);
  const changedEnvironment = plan.sessions.map((session, index) => ({
    ...session,
    environment: index === 1 ? "nix" : "native",
  }));
  expect(checkGroupDependencies(root, changedEnvironment, plan.ordering, true)[1]).toEqual([
    { session: 0, phase: "complete" },
  ]);
  const noSetup = plan.sessions.map((session) => ({
    ...session,
    checks: session.checks.filter((check) => check.role !== "setup"),
  }));
  expect(checkGroupDependencies(root, noSetup, plan.ordering, true)[1]).toEqual([{ session: 0, phase: "complete" }]);
});

test("a focused worker validates global ordering without planning an unselected root's setup", async () => {
  const root = fixture([{ root: "a", after: ".", phase: "setup" }]);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "preferences"));
  const config = readConfig(root);
  required(
    config.check?.find((check) => check.name === "a setup"),
    "unselected setup",
  ).stages = [];
  delete config.check_order;
  writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  await expect(runChecks(root, { path: ".", environment: "native" })).resolves.toBeUndefined();
  expect(() => planChecks(root, readChecks(root))).toThrow(/setup is excluded/);
});

test.each(
  [
    [{ root: "unknown", after: ".", phase: "setup" }],
    [{ root: "a", after: "a", phase: "setup" }],
    [
      { root: "a", after: ".", phase: "setup" },
      { root: "a", after: ".", phase: "complete" },
    ],
    [{ root: ".", after: "a", phase: "setup" }],
    [
      { root: "a", after: "b", phase: "complete" },
      { root: "b", after: "a", phase: "setup" },
    ],
    [{ root: "../escape", after: ".", phase: "setup" }],
    [{ root: "a", after: ".", phase: "ready" }],
    [{ root: "a", after: "." }],
    [{ root: "a", phase: "setup" }],
  ].map((ordering) => [ordering] as const),
)("invalid ordering %j fails before selection or execution", (ordering) => {
  const root = fixture(ordering);
  expect(() => readChecks(root)).toThrow(/check_order/);
});

test("refresh plans derive their own dependency graph without mutating the original plan", () => {
  const root = fixture([{ root: "a", after: ".", phase: "setup" }]);
  const plan = planChecks(root, readChecks(root));
  const selected = plan.sessions.slice(0, 2);
  const before = structuredClone(plan);
  const session = required(selected[1], "selected example");
  const check = required(session.checks[0], "selected setup");
  const refreshed = [{ ...session, checks: [{ ...check, role: "secret" }] }];
  expect(checkGroupDependencies(root, refreshed, plan.ordering, true)).toEqual([[]]);
  expect(checkExecution(root, { ...plan, sessions: refreshed }).dependencies).toEqual([[]]);
  expect(plan).toEqual(before);
});
