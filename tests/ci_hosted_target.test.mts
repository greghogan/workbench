import { required } from "../src/invariants.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHostedCITarget } from "../src/ci-hosted-target.ts";
import { ciTargets, type CITarget } from "../src/ci-targets.ts";
import { ciDestination } from "../src/ci-destinations.ts";
import { CIProvider } from "../src/ci-hosting.ts";
import { readConfig } from "../src/project-configuration.ts";
import { acquireCIImage } from "../src/ci-images.ts";
import { installContainerTools } from "../src/native-tools.ts";
import { executePreparedProfile } from "../src/offline-profiles.ts";
import { executeCITargets } from "../scripts/ci-execution.mjs";
import { createRunReport, writeRunReport } from "../scripts/ci-results.mjs";
vi.mock("../src/ci-targets.ts", () => ({ ciTargets: vi.fn() }));
vi.mock("../src/ci-destinations.ts", () => ({ ciDestination: vi.fn() }));
vi.mock("../src/project-configuration.ts", () => ({ readConfig: vi.fn() }));
vi.mock("../src/ci-images.ts", () => ({ acquireCIImage: vi.fn() }));
vi.mock("../src/native-tools.ts", () => ({ installContainerTools: vi.fn() }));
vi.mock("../src/offline-profiles.ts", () => ({ executePreparedProfile: vi.fn() }));
vi.mock("../scripts/ci-execution.mjs", () => ({ executeCITargets: vi.fn() }));
vi.mock("../src/project-context.ts", () => ({ distributionRoot: () => "/distribution" }));
const roots: string[] = [];
let root: string;
let target: CITarget;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-hosted-target-"));
  roots.push(root);
  target = {
    id: "selected",
    kind: "native",
    path: ".",
    os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform,
    architecture: process.arch,
    environment: "native",
    phases: ["native-install", "native-check", "integration", "release"],
    integration: true,
    release: true,
    checks: [],
  };
  vi.mocked(ciTargets).mockReturnValue([target]);
  vi.mocked(ciDestination).mockReturnValue({
    remote: "gitlab",
    provider: CIProvider.GitLab,
    repository: "https://gitlab.example/group/project",
    registries: { native: "registry.example/group/project/native" },
  });
  vi.mocked(readConfig).mockReturnValue({});
  vi.mocked(installContainerTools).mockResolvedValue();
});
afterEach(() => {
  vi.resetAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("unknown and foreign platform selections cannot start target work", async () => {
  await expect(runHostedCITarget(root, "unknown", "gitlab", "reports")).rejects.toThrow(/Unknown CI target/);
  target.architecture = process.arch === "arm64" ? "x64" : "arm64";
  await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/native OS and architecture/);
  expect(executeCITargets).not.toHaveBeenCalled();
  expect(acquireCIImage).not.toHaveBeenCalled();
});
test("native targets retain all selected phases and fail when their shared execution report fails", async () => {
  vi.mocked(executeCITargets).mockImplementation((options) => {
    const run = createRunReport(
      options.targets.map((t) => t.id),
      options.reports,
    );
    writeRunReport(options.resultFile, run);
    return Promise.resolve(run);
  });
  await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/CI target failed/);
  expect(vi.mocked(executeCITargets).mock.calls[0]?.[0].targets[0]?.phases).toEqual(target.phases);
  expect(
    JSON.parse(
      readFileSync(
        required(vi.mocked(executeCITargets).mock.calls[0]?.[0].resultFile, "Expected retained native report"),
        "utf8",
      ),
    ) as unknown,
  ).toMatchObject({
    targets: [{ id: target.id, success: false }],
  });
  const passed = createRunReport([target.id], join(root, "reports"));
  for (const result of passed.targets) {
    result.success = true;
    result.started = result.finished = new Date().toISOString();
    delete result.error;
  }
  vi.mocked(executeCITargets).mockResolvedValueOnce(passed);
  await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).resolves.toBeUndefined();
});
test.skipIf(process.platform !== "linux")(
  "unavailable prepared images cannot fall back to host installation",
  async () => {
    vi.mocked(readConfig).mockReturnValue({ ci: { images: { native: "native" } } });
    vi.mocked(acquireCIImage).mockRejectedValue(new Error("Required published image is unavailable"));
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/published image/);
    expect(executePreparedProfile).not.toHaveBeenCalled();
    expect(installContainerTools).not.toHaveBeenCalled();
    expect(executeCITargets).not.toHaveBeenCalled();
  },
);
test.skipIf(process.platform !== "linux")(
  "prepared targets require complete results for the selected target",
  async () => {
    vi.mocked(readConfig).mockReturnValue({ ci: { images: { native: "native" } } });
    const image = {
      version: 1 as const,
      profile: "native",
      platform: process.arch === "arm64" ? ("linux-arm64" as const) : ("linux-x64" as const),
      inputs: "a".repeat(64),
      image: `sha256:${"b".repeat(64)}`,
      reference: "registry.example/group/project/native:inputs",
      published: `registry.example/group/project/native@sha256:${"c".repeat(64)}`,
    };
    vi.mocked(acquireCIImage).mockResolvedValue(image);
    vi.mocked(executePreparedProfile).mockImplementation((_root, _profile, _command, options) => {
      writeFileSync(
        join(required(options?.reports, "Expected guest reports"), "guest-results.json"),
        JSON.stringify({ version: 1, targets: [], errors: [] }),
      );
      return Promise.resolve();
    });
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/invalid target results/);
    expect(
      JSON.parse(
        readFileSync(
          join(
            required(vi.mocked(executePreparedProfile).mock.calls[0]?.[3]?.reports, "Expected retained image report"),
            "image.json",
          ),
          "utf8",
        ),
      ) as unknown,
    ).toEqual(image);
    expect(executeCITargets).not.toHaveBeenCalled();
    vi.mocked(executePreparedProfile).mockImplementation((_root, _profile, _command, options) => {
      const passed = createRunReport([target.id], options?.reports ?? "");
      for (const result of passed.targets) {
        result.success = true;
        result.started = result.finished = new Date().toISOString();
        delete result.error;
      }
      writeRunReport(join(required(options?.reports, "Expected guest reports"), "guest-results.json"), passed);
      return Promise.resolve();
    });
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).resolves.toBeUndefined();
    expect(installContainerTools).toHaveBeenCalledWith(root);
    vi.mocked(installContainerTools).mockRejectedValueOnce(new Error("Container companion acquisition failed"));
    const executions = vi.mocked(executePreparedProfile).mock.calls.length;
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(
      /companion acquisition failed/,
    );
    expect(vi.mocked(executePreparedProfile).mock.calls.length).toBe(executions);
    vi.mocked(executePreparedProfile).mockResolvedValueOnce();
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/ENOENT/);
  },
);
