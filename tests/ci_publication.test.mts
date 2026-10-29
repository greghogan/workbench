import { readWorkflow, executionJob } from "./fixtures/workflow.mjs";
import { required } from "../src/invariants.ts";
import { expect, test } from "vitest";

test("development publication natively qualifies all required images without a dependency on Checks", () => {
  const workflow = readWorkflow(new URL("../.github/workflows/publication.yml", import.meta.url));
  expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(required(executionJob(workflow, "publish").strategy, "Publication matrix").matrix.include).toEqual([
    { builder: "native", architecture: "x64" },
    { builder: "nix", architecture: "x64" },
    { builder: "guix", architecture: "x64" },
    { builder: "native", architecture: "arm64" },
    { builder: "nix", architecture: "arm64" },
    { builder: "guix", architecture: "arm64" },
  ]);
  const steps = executionJob(workflow, "publish").steps;
  expect(workflow.permissions.packages).toBeUndefined();
  expect(required(executionJob(workflow, "publish").permissions, "Publication permissions").packages).toBe("write");
  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(commands.find((command) => command.includes("bin/workbench.mjs"))).toBe(
    "node bin/workbench.mjs project add .",
  );
  expect(commands.some((command) => command.includes("actions/runs"))).toBe(false);
  expect(commands.some((command) => command.includes("release prepare"))).toBe(false);
  const prepare = commands.findIndex((command) => command.includes("development prepare"));
  const verify = commands.findIndex((command) => command.includes("development verify"));
  const publish = commands.findIndex((command) => command.includes("development publish"));
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThanOrEqual(prepare);
  expect(publish).toBeGreaterThan(verify);
});

test("check jobs retain read-only registry access and cannot acquire publication permissions", () => {
  for (const file of ["checks.yml", "native-platform.yml"]) {
    const workflow = readWorkflow(new URL(`../.github/workflows/${file}`, import.meta.url));
    expect(workflow.permissions).toEqual({ contents: "read", packages: "read" });
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const writes = Object.entries(job.permissions ?? {}).filter(([, permission]) => permission === "write");
      expect(writes).toEqual(file === "checks.yml" && id === "security" ? [["security-events", "write"]] : []);
      if (job.kind === "reusable") {
        expect(job.uses).toMatch(/^\.\/\.github\/workflows\//);
        continue;
      }
      for (const step of job.steps) expect(step.env?.WORKBENCH_PUBLISH_IMAGES).toBeUndefined();
    }
  }
});
