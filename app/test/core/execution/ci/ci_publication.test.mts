import { readWorkflow, executionJob, reusableJob } from "../../../fixtures/workflow.mjs";
import { required } from "../../../../src/core/runtime/invariants.ts";
import { expect, test } from "vitest";

test("artifact publication natively qualifies all required images before obtaining registry write credentials", () => {
  const dispatcher = readWorkflow(new URL("../../../../../.github/workflows/publication.yml", import.meta.url));
  const image = reusableJob(dispatcher, "image");
  expect(Object.keys(dispatcher.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(dispatcher.on.workflow_dispatch).toMatchObject({ inputs: { kind: { default: "toolchain" } } });
  expect(image.uses).toBe("./.github/workflows/publish-image.yml");
  expect(image.with?.kind).toBe("${{ inputs.kind || 'toolchain' }}");
  expect(required(image.strategy, "Publication matrix").matrix.include).toEqual([
    { builder: "native", architecture: "x64" },
    { builder: "nix", architecture: "x64" },
    { builder: "guix", architecture: "x64" },
    { builder: "native", architecture: "arm64" },
    { builder: "nix", architecture: "arm64" },
    { builder: "guix", architecture: "arm64" },
  ]);
  const workflow = readWorkflow(new URL("../../../../../.github/workflows/publish-image.yml", import.meta.url));
  const prepare = executionJob(workflow, "prepare");
  const delivery = executionJob(workflow, "publish");
  expect(workflow.permissions.packages).toBeUndefined();
  expect(prepare.permissions?.packages).toBeUndefined();
  expect(delivery.permissions?.packages).toBe("write");
  const build = prepare.steps.findIndex((step) => step.run?.includes('artifact build "$BUILDER"'));
  const transfer = prepare.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const receive = delivery.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(build).toBeGreaterThanOrEqual(0);
  expect(prepare.steps[build]?.run).toContain('--export "$transfer"');
  expect(transfer?.with?.name).toBeDefined();
  expect(receive?.with?.name).toBe(transfer?.with?.name);
  expect(
    prepare.steps.some((step) => step.env?.REGISTRY_TOKEN !== undefined || step.run?.includes("docker login")),
  ).toBe(false);

  const qualify = delivery.steps.findIndex((step) => step.run?.includes('artifact import "$BUILDER"'));
  const publish = delivery.steps.findIndex((step) => step.run?.includes('artifact publish "$BUILDER"'));
  expect(qualify).toBeGreaterThan(delivery.steps.indexOf(required(receive, "Image download")));
  expect(delivery.steps[qualify]?.run).toContain('--sha256 "$digest"');
  expect(publish).toBeGreaterThan(qualify);
  expect(delivery.steps[publish]?.run).toContain("docker login");
  expect(delivery.steps.filter((step) => step.env?.REGISTRY_TOKEN)).toEqual([delivery.steps[publish]]);
});

test("check jobs retain read-only registry access and cannot acquire publication permissions", () => {
  for (const file of ["checks.yml", "native-platform.yml"]) {
    const workflow = readWorkflow(new URL(`../../../../../.github/workflows/${file}`, import.meta.url));
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
