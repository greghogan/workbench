import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCandidate } from "../scripts/ci-candidate.mts";
import { successfulReleaseRun } from "../scripts/release-contract.mts";
import { checkedCIImage } from "../src/ci-images.ts";

const revision = "a".repeat(40),
  repository = "owner/project";
function releaseRun() {
  return {
    id: 123,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    event: "push",
    path: ".github/workflows/checks.yml",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: revision,
    run_attempt: 2,
  };
}

test("publication accepts only complete successful main Checks from the selected repository", () => {
  expect(successfulReleaseRun(releaseRun(), repository, "123")).toEqual({ revision, attempt: "2" });
  for (const changed of [
    { id: 124 },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_branch: "other" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "fork/project" } },
    { repository: { full_name: "fork/project" } },
    { head_sha: "main" },
    { run_attempt: 0 },
  ])
    expect(() => successfulReleaseRun({ ...releaseRun(), ...changed }, repository, "123")).toThrow(
      /successful complete Checks/,
    );
});

test("portable candidates reject changed bytes, source identity, version, and checksum records", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-candidate-"));
  try {
    const directory = join(root, "workbench-artifacts");
    mkdirSync(directory);
    const bytes = Buffer.from("exact candidate bytes"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(directory, "workbench.tar.gz"), bytes);
    writeFileSync(join(directory, "SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
    const metadata = { version: 1, repository, revision, release: "1.2.3", sha256 };
    const manifest = join(root, "candidate.json");
    writeFileSync(manifest, JSON.stringify(metadata));
    expect(readCandidate(root, repository, revision)).toEqual(metadata);
    for (const changed of [
      { repository: "other/project" },
      { revision: "b".repeat(40) },
      { release: "../1.2" },
      { sha256: "0".repeat(64) },
    ]) {
      writeFileSync(manifest, JSON.stringify({ ...metadata, ...changed }));
      expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
    }
    writeFileSync(manifest, JSON.stringify(metadata));
    writeFileSync(join(directory, "workbench.tar.gz"), "changed");
    expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
    writeFileSync(join(directory, "workbench.tar.gz"), bytes);
    writeFileSync(join(directory, "SHA256SUMS"), readFileSync(join(directory, "SHA256SUMS"), "utf8") + "extra\n");
    expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI image acquisition binds platform, declared inputs, builder, volumes, and immutable registry identity", () => {
  const expected = {
    profile: "native",
    platform: "linux-x64",
    inputs: "c".repeat(64),
    reference: "ghcr.io/owner/image:inputs",
  } as const;
  const image = {
    Id: `sha256:${"a".repeat(64)}`,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [`ghcr.io/owner/image@sha256:${"b".repeat(64)}`],
    Config: { Labels: { "org.workbench.inputs": "c".repeat(64), "org.workbench.builder": "native" } },
  };
  expect(checkedCIImage(image, expected, "native").published).toBe(image.RepoDigests[0]);
  for (const changed of [
    { Os: "windows" },
    { Architecture: "arm64" },
    { Id: "mutable-tag" },
    { Config: { Labels: { ...image.Config.Labels, "org.workbench.inputs": "other" } } },
    { Config: { Labels: { ...image.Config.Labels, "org.workbench.builder": "guix" } } },
    { Config: { ...image.Config, Volumes: { "/data": {} } } },
    { RepoDigests: [] },
  ])
    expect(() => checkedCIImage({ ...image, ...changed }, expected, "native")).toThrow(/CI image|Acquired CI image/);
});
