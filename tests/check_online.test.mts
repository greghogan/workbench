import { required } from "../src/invariants.ts";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runChecks, readChecks, inspectChecks } from "../src/checks.ts";
import { planChecks } from "../src/check-plan.ts";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const distribution = resolve(import.meta.dirname, "..");

const fixture = stageFixtures();

test("online selection keeps required setup, respects scopes and remains part of CI", async () => {
  const { root, config, save, events, clear } = fixture();
  config.check.push({
    name: "network policy",
    role: "policy-audit",
    path: "service",
    online: true,
    command: ["node", "step.cjs", "policy-audit"],
  });
  save();
  const configured = readChecks(root);
  expect(planChecks(root, configured).sessions.flatMap((s) => s.checks.map((c) => c.name))).not.toContain(
    "network policy",
  );
  expect(planChecks(root, configured, { stage: "ci" }).sessions.flatMap((s) => s.checks.map((c) => c.name))).toContain(
    "network policy",
  );
  await runChecks(root, { stage: "ci", online: true, project: "service" });
  expect(events("service")).toEqual(["setup", "policy-audit"]);
  expect(existsSync(join(root, "service/worker/events"))).toBe(false);
  clear();
  expect(planChecks(root, configured, { stage: "ci", online: true, path: "." }).sessions).toEqual([]);
  required(config.check.at(-1), "Expected fixture value: config.check.at(-1)").online = "true";
  save();
  expect(() => readChecks(root)).toThrow(/online.*Boolean/);
});

test("online test coverage inherits the CI-only schedule", () => {
  const { root, config, save } = fixture();
  required(config.check[1], "Expected fixture value: config.check[1]").online = true;
  delete required(
    required(config.check[1], "Expected fixture value: config.check[1]").coverage,
    'Fixture value required(config.check[1], "Expected fixture value: config.check[1]").c',
  ).stages;
  save();
  const check = readChecks(root).find(
    (entry) => entry.name === required(config.check[1], "Expected fixture value: config.check[1]").name,
  );
  expect(required(check, "Expected fixture value: check").stages).toEqual(["ci"]);
  expect(
    required(required(check, "Expected fixture value: check").coverage, "Expected fixture value: check.coverage")
      .stages,
  ).toEqual(["ci"]);
});

test("independent online checks run fresh without installing dependencies", async () => {
  const { root, config, save } = fixture();
  required(config.check[0], "Expected fixture value: config.check[0]").stages = [];
  config.check.push({
    name: "lockfile advisory",
    role: "advisory",
    path: ".",
    online: true,
    requires_setup: false,
    command: [process.execPath, "-e", "require('node:fs').appendFileSync('advisory-runs', 'checked\\n')"],
  });
  save();
  const options = { stage: "ci", online: true, path: "." };
  const inspection = inspectChecks(root, options);
  expect(inspection.selected.map(({ role }) => role)).toEqual(["advisory"]);
  expect(required(inspection.selected[0], "Expected fixture value: inspection.selected[0]").requiresSetup).toBe(false);
  await runChecks(root, options);
  await runChecks(root, options);
  expect(readFileSync(join(root, "advisory-runs"), "utf8")).toBe("checked\nchecked\n");
  expect(existsSync(join(root, "dependency"))).toBe(false);
  expect(existsSync(join(root, "events"))).toBe(false);
});

test.each([true, false])("mixed online checks retain setup regardless of ordering: %s", async (independentFirst) => {
  const { root, config, save, events, clear } = fixture();
  const independent = {
    name: "independent audit",
    role: "policy-audit",
    path: ".",
    online: true,
    requires_setup: false,
    command: [process.execPath, "-e", "require('node:fs').appendFileSync('events', 'independent\\n')"],
  };
  const dependent = {
    name: "installed dependency audit",
    role: "policy-audit",
    path: ".",
    online: true,
    command: [process.execPath, "step.cjs", "dependent"],
  };
  config.check.push(...(independentFirst ? [independent, dependent] : [dependent, independent]));
  save();
  await runChecks(root, { stage: "ci", online: true, path: "." });
  expect(events()).toEqual([
    "setup",
    ...(independentFirst ? ["independent", "dependent"] : ["dependent", "independent"]),
  ]);
  clear();
  required(config.check[0], "Expected fixture value: config.check[0]").stages = [];
  save();
  expect(() => planChecks(root, readChecks(root), { stage: "ci", online: true, path: "." })).toThrow(
    /setup is excluded/,
  );
  await runChecks(root, { role: ["setup"], path: "." });
  expect(events()).toEqual(["setup"]);
});

test("setup requirements are Boolean and inherited from selected language commands", () => {
  const { root, config, save } = fixture();
  required(config.check[1], "Expected fixture value: config.check[1]").requires_setup = "false";
  save();
  expect(() => readChecks(root)).toThrow(/requires_setup.*Boolean/);
  const plan = inspectChecks(distribution, { stage: "ci", online: true });
  expect(plan.selected).toHaveLength(10);
  expect(plan.selected.every((check) => check.role === "advisory" && !check.requiresSetup)).toBe(true);
});
