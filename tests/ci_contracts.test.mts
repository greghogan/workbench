import { expect, test } from "vitest";
import { readAcquiredCIImage } from "../scripts/ci-image-contract.mjs";
import { parseWorkflow, executionJob, reusableJob } from "./fixtures/workflow.mjs";
import { readReleaseProof, verifyReleaseCandidate } from "../scripts/release-contract.mts";

test("image handoffs reject missing or contradictory transport identities", () => {
  const image = {
    version: 1,
    profile: "native",
    platform: "linux-x64",
    inputs: "a".repeat(64),
    image: `sha256:${"b".repeat(64)}`,
    reference: "registry.example:5000/team/image:inputs",
    published: `registry.example:5000/team/image@sha256:${"c".repeat(64)}`,
  };
  expect(readAcquiredCIImage(image)).toEqual(image);
  const archive: Record<string, unknown> = { ...image };
  Reflect.deleteProperty(archive, "published");
  expect(() => readAcquiredCIImage(archive)).toThrow(/immutable published identity/);
  for (const changed of [
    { published: undefined },
    { published: "registry.example:5000/team/image:latest" },
    { platform: "linux-other" },
    { image: "mutable" },
    { inputs: "unhashed" },
    { version: 2 },
    { unexpected: true },
  ])
    expect(() => readAcquiredCIImage({ ...image, ...changed })).toThrow();
});
test("workflow fixtures model runnable jobs and reusable calls as exclusive contracts", () => {
  const raw = {
    on: { push: null },
    permissions: { contents: "read" },
    jobs: { tests: { steps: [{ run: "test" }] }, native: { uses: "./.github/workflows/native.yml" } },
  };
  const workflow = parseWorkflow(raw);
  expect(executionJob(workflow, "tests").steps[0]?.run).toBe("test");
  expect(reusableJob(workflow, "native").uses).toContain("native.yml");
  expect(() => executionJob(workflow, "native")).toThrow(/executable/);
  expect(() => reusableJob(workflow, "tests")).toThrow(/reusable/);
  expect(() => parseWorkflow({ ...raw, jobs: { invalid: { uses: "workflow.yml", steps: [] } } })).toThrow(
    /cannot also declare steps/,
  );
  expect(() => parseWorkflow({ ...raw, jobs: { invalid: {} } })).toThrow(/Missing steps/);
});
test("release proofs bind exact attempts, source versions and candidate bytes before publication", () => {
  const selected = { revision: "a".repeat(40), attempt: "2" },
    repository = "owner/project",
    id = "123";
  const raw = {
    version: 1,
    run: id,
    attempt: "2",
    repository,
    revision: selected.revision,
    artifact: "workbench-candidate-123-1",
    sha256: "b".repeat(64),
    release: "1.2.3",
  };
  const proof = readReleaseProof(raw, repository, id, selected);
  const candidate = {
    version: 1 as const,
    repository,
    revision: selected.revision,
    release: "1.2.3",
    sha256: raw.sha256,
  };
  verifyReleaseCandidate(proof, candidate, { version: "1.2.3" });
  for (const changed of [
    { attempt: "1" },
    { repository: "fork/project" },
    { run: "124" },
    { artifact: "workbench-candidate-124-1" },
    { version: 2 },
  ])
    expect(() => readReleaseProof({ ...raw, ...changed }, repository, id, selected)).toThrow(/another run or revision/);
  expect(() => {
    verifyReleaseCandidate(proof, { ...candidate, sha256: "c".repeat(64) }, { version: "1.2.3" });
  }).toThrow(/differs from the tested/);
  expect(() => {
    verifyReleaseCandidate(proof, candidate, { version: "2.0.0" });
  }).toThrow(/version differs/);
});
