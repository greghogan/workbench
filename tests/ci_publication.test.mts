import type { Workflow } from "./fixtures/workflow.mjs";
import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { verifyRegistryPublication } from "../scripts/ci-publish.mjs";

test("explicit registry verification covers release images and all offline development builders", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/publication.yml", import.meta.url), "utf8"),
  ) as Workflow;
  expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(
    required(workflow.jobs.publish.strategy, "Fixture value workflow.jobs.publish.strategy").matrix.include,
  ).toEqual([
    { kind: "release", builder: "nix" },
    { kind: "release", builder: "guix" },
    { kind: "development", builder: "native" },
    { kind: "development", builder: "nix" },
    { kind: "development", builder: "guix" },
  ]);
  const steps = workflow.jobs.publish.steps;
  expect(workflow.permissions.packages).toBeUndefined();
  expect(required(workflow.jobs.publish.permissions, "Fixture value workflow.jobs.publish.permissions").packages).toBe(
    "write",
  );
  for (const operation of ["prepare", "publish"])
    expect(steps.find((step) => step.run?.includes(`development ${operation}`))?.if).toBe(
      "matrix.kind == 'development'",
    );
});

test("check jobs retain read-only registry access and cannot acquire publication permissions", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8")) as Workflow;
  expect(workflow.permissions).toEqual({ contents: "read", packages: "read" });
  for (const job of Object.values(workflow.jobs)) {
    for (const permission of Object.values(job.permissions ?? {})) expect(permission).not.toBe("write");
    for (const step of job.steps) expect(step.env?.WORKBENCH_PUBLISH_IMAGES).toBeUndefined();
  }
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-publication-"));
  temporary.push(root);
  const path = join(root, "dist/releases/go-nix-docker");
  mkdirSync(path, { recursive: true });
  const archive = Buffer.from("verified archive fixture");
  writeFileSync(join(path, "docker.tar.gz"), archive);
  const receipt = {
    version: 1,
    verified: true,
    emulation: false,
    builder: "nix",
    profile: { name: "go-nix-docker" },
    source: { revision: "1".repeat(40), dirty: false },
    artifacts: [
      {
        path: "docker.tar.gz",
        type: "file",
        size: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    ],
  };
  const record = join(path, "workbench-release.json");
  writeFileSync(record, JSON.stringify(receipt));
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: "Fixture/Workbench",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: root,
  };
  const calls: string[][] = [];
  const id = "sha256:" + "2".repeat(64);
  const digest = "ghcr.io/fixture/workbench-ci-nix@sha256:" + "3".repeat(64);
  const backend = {
    hasImage: () => false,
    docker: (...args: string[]) => {
      calls.push(args);
      if (args[0] === "run") return "3";
      if (args.includes("{{.Id}}")) return id;
      if (args.includes("{{json .RepoDigests}}")) return JSON.stringify([digest]);
      return "";
    },
  };
  return { root, record, receipt, env, calls, id, digest, backend };
}
test.each([false, true])(
  "publication verifies identity and behavior from selected artifacts (external: %s)",
  async (external) => {
    const f = fixture();
    if (external) {
      const cache = mkdtempSync(join(tmpdir(), "workbench-publication-cache-"));
      temporary.push(cache);
      const artifacts = join(cache, "prepared");
      renameSync(dirname(f.record), artifacts);
      f.env.WORKBENCH_RELEASE_ARTIFACT = artifacts;
    }
    const result = await verifyRegistryPublication(f.root, "nix", f.env, f.backend);
    expect(result).toMatchObject({ published: true, verified: true, deployed: false, digest: f.digest, imageID: f.id });
    expect(f.calls).toContainEqual(["pull", f.digest]);
    expect(f.calls).toContainEqual(["run", "--rm", "--pull=never", "--network=none", f.digest, "a", "banana"]);
    const push = f.calls.findIndex(([operation]) => operation === "push");
    const removal = f.calls.findIndex(([operation, , image]) => operation === "image" && image?.includes(":ci-"));
    const pull = f.calls.findIndex(([operation]) => operation === "pull");
    expect(push).toBeLessThan(removal);
    expect(removal).toBeLessThan(pull);
    expect(JSON.parse(readFileSync(join(f.root, "publication-evidence/nix-workbench-release.json"), "utf8"))).toEqual(
      f.receipt,
    );
  },
);
test("unverified or changed publication artifacts fail before Docker or registry effects", async () => {
  const f = fixture();
  f.receipt.verified = false;
  writeFileSync(f.record, JSON.stringify(f.receipt));
  await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(
    /verified native release receipt/,
  );
  expect(f.calls).toEqual([]);
  f.receipt.verified = true;
  required(f.receipt.artifacts[0], "Expected fixture value: f.receipt.artifacts[0]").sha256 = "0".repeat(64);
  writeFileSync(f.record, JSON.stringify(f.receipt));
  await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(/differs/);
  expect(f.calls).toEqual([]);
});

test("publication rejects dirty or unknown source state before Docker or registry effects", async () => {
  for (const dirty of [true, null, undefined]) {
    const f = fixture();
    Object.assign(f.receipt.source, { dirty });
    writeFileSync(f.record, JSON.stringify(f.receipt));
    await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(
      /verified native release receipt/,
    );
    expect(f.calls).toEqual([]);
  }
});
