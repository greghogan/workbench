import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareHostedCI, runHostedCIJob } from "../src/ci-hosted-jobs.ts";
import { ciJobGroups, type CIJobGroup } from "../src/ci-job-plan.ts";
import { ciDestination } from "../src/ci-destinations.ts";
import { workingReviewTree } from "../src/git-snapshot.ts";
import { executeCI } from "../scripts/ci-lifecycle.mjs";
import { acquireCIImage, restoreCIImage } from "../src/ci-images.ts";
import { executeHostedCISelection } from "../src/ci-hosted-target.ts";
import { CIOperation } from "../scripts/ci-operations.mjs";
import { CIProvider } from "../src/ci-hosting.ts";
vi.mock("../src/ci-job-plan.ts", () => ({ ciJobGroups: vi.fn() }));
vi.mock("../src/ci-destinations.ts", () => ({ ciDestination: vi.fn() }));
vi.mock("../src/git-snapshot.ts", () => ({ workingReviewTree: vi.fn() }));
vi.mock("../scripts/ci-lifecycle.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/ci-lifecycle.mjs")>()),
  executeCI: vi.fn(),
}));
vi.mock("../src/ci-images.ts", () => ({ acquireCIImage: vi.fn(), restoreCIImage: vi.fn() }));
vi.mock("../src/ci-hosted-target.ts", () => ({ executeHostedCISelection: vi.fn() }));
vi.mock("../src/project-context.ts", () => ({ distributionRoot: () => "/distribution" }));
let root: string, group: CIJobGroup;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-ci-preparation-"));
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  const target = {
    kind: "native" as const,
    id: "native-target",
    path: "writer's notes",
    os,
    architecture: process.arch,
    environment: "native",
    release: false as const,
    phases: ["native-install", "native-check"] as ("native-install" | "native-check")[],
    checks: [],
  };
  group = {
    id: `${os}-${process.arch}-native`,
    os,
    architecture: process.arch,
    environment: "native",
    targets: [target],
    jobs: [
      { id: "checks", artifact: "checks-identity", label: "Checks", operation: CIOperation.Checks, targets: [target] },
    ],
  };
  vi.mocked(ciJobGroups).mockImplementation(() => structuredClone([group]));
  vi.mocked(ciDestination).mockReturnValue({
    remote: "origin",
    provider: CIProvider.GitHub,
    repository: "https://github.com/owner/project",
    registries: {},
  });
  vi.mocked(workingReviewTree).mockReturnValue("a".repeat(40));
  vi.mocked(executeCI).mockResolvedValue("");
  vi.mocked(executeHostedCISelection).mockResolvedValue();
});
afterEach(() => {
  vi.resetAllMocks();
  rmSync(root, { recursive: true, force: true });
});
test("preparation installs without running checks, and a matching operation receives its complete selected targets", async () => {
  await prepareHostedCI(root, group.id, "origin", "prepared");
  expect(executeHostedCISelection).not.toHaveBeenCalled();
  expect(vi.mocked(executeCI).mock.calls.map(([, args]) => args.at(-1))).toEqual(["native-install"]);
  await runHostedCIJob(root, group.id, "checks-identity", "origin", "prepared/prepared.json", "reports");
  expect(vi.mocked(executeHostedCISelection).mock.calls[0]?.[1]).toEqual(group.targets);
  expect(vi.mocked(executeHostedCISelection).mock.calls[0]?.[3]).toMatchObject({ operation: CIOperation.Checks });
});
test("failed preparation removes old success evidence and changing source cannot establish a preparation receipt", async () => {
  await prepareHostedCI(root, group.id, "origin", "prepared");
  vi.mocked(executeCI).mockRejectedValueOnce(new Error("installation failed"));
  await expect(prepareHostedCI(root, group.id, "origin", "prepared")).rejects.toThrow(/installation failed/);
  expect(existsSync(join(root, "prepared/prepared.json"))).toBe(false);
  vi.mocked(workingReviewTree).mockReturnValueOnce("a".repeat(40)).mockReturnValueOnce("b".repeat(40));
  await expect(prepareHostedCI(root, group.id, "origin", "prepared")).rejects.toThrow(/inputs changed/);
  expect(existsSync(join(root, "prepared/prepared.json"))).toBe(false);
});
test("a changed snapshot or altered receipt cannot start an operation", async () => {
  await prepareHostedCI(root, group.id, "origin", "prepared");
  vi.mocked(workingReviewTree).mockReturnValue("b".repeat(40));
  await expect(
    runHostedCIJob(root, group.id, "checks-identity", "origin", "prepared/prepared.json", "reports"),
  ).rejects.toThrow(/different source/);
  vi.mocked(workingReviewTree).mockReturnValue("a".repeat(40));
  const path = join(root, "prepared/prepared.json"),
    receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  receipt.group = "foreign-group";
  writeFileSync(path, JSON.stringify(receipt));
  await expect(
    runHostedCIJob(root, group.id, "checks-identity", "origin", "prepared/prepared.json", "reports"),
  ).rejects.toThrow(/different source/);
  expect(executeHostedCISelection).not.toHaveBeenCalled();
});
test("unknown jobs and foreign native platforms cannot acquire images or start installation", async () => {
  await expect(runHostedCIJob(root, group.id, "missing", "origin", "missing", "reports")).rejects.toThrow(
    /Unknown configured CI operation/,
  );
  group.architecture = process.arch === "x64" ? "arm64" : "x64";
  await expect(prepareHostedCI(root, group.id, "origin", "prepared")).rejects.toThrow(
    /native OS|native OS and architecture/,
  );
  expect(acquireCIImage).not.toHaveBeenCalled();
  expect(executeCI).not.toHaveBeenCalled();
});
test("prepared groups preserve the immutable acquisition handoff and restore it before execution", async () => {
  group.profile = "native-image";
  const image = {
    version: 1 as const,
    profile: "native-image",
    platform: "linux-x64" as const,
    inputs: "a".repeat(64),
    image: `sha256:${"b".repeat(64)}`,
    reference: "registry.example/image:inputs",
    published: `registry.example/image@sha256:${"c".repeat(64)}`,
  };
  vi.mocked(acquireCIImage).mockResolvedValue(image);
  vi.mocked(restoreCIImage).mockResolvedValue(image);
  await prepareHostedCI(root, group.id, "origin", "prepared");
  expect(executeCI).not.toHaveBeenCalled();
  await runHostedCIJob(root, group.id, "checks-identity", "origin", "prepared/prepared.json", "reports");
  expect(vi.mocked(restoreCIImage).mock.calls[0]?.[2]).toEqual(image);
  expect(vi.mocked(executeHostedCISelection).mock.calls[0]?.[3]).toMatchObject({ profile: group.profile, image });
});
