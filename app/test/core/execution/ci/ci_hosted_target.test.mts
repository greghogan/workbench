import { required } from "../../../../src/core/runtime/invariants.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeHostedCISelection,
  executePreparedCISelection,
  runHostedCITarget,
} from "../../../../src/core/execution/ci/ci-hosted-target.ts";
import { ciTargets, type CITarget } from "../../../../src/core/execution/ci/ci-targets.ts";
import { ciDestination } from "../../../../src/core/execution/ci/ci-destinations.ts";
import { CIProvider } from "../../../../src/core/execution/ci/ci-hosting.ts";
import { readConfig } from "../../../../src/core/projects/project-configuration.ts";
import { acquireCIImage } from "../../../../src/core/execution/ci/ci-images.ts";
import { installContainerTools } from "../../../../src/core/toolchains/native/native-tools.ts";
import { withPreparedProfile } from "../../../../src/core/artifacts/offline-profiles.ts";
import { executeCITargets } from "../../../../src/core/execution/ci/support/ci-execution.mjs";
import { createRunReport, writeRunReport } from "../../../../src/core/execution/ci/support/ci-results.mjs";
import { CIOperation } from "../../../../src/core/execution/ci/support/ci-operations.mjs";
import type { AcquiredCIImage } from "../../../../src/core/execution/ci/support/ci-image-contract.mjs";
vi.mock("../../../../src/core/execution/ci/ci-targets.ts", () => ({ ciTargets: vi.fn() }));
vi.mock("../../../../src/core/execution/ci/ci-destinations.ts", () => ({ ciDestination: vi.fn() }));
vi.mock("../../../../src/core/projects/project-configuration.ts", () => ({ readConfig: vi.fn() }));
vi.mock("../../../../src/core/execution/ci/ci-images.ts", () => ({ acquireCIImage: vi.fn() }));
vi.mock("../../../../src/core/toolchains/native/native-tools.ts", () => ({ installContainerTools: vi.fn() }));
vi.mock("../../../../src/core/artifacts/offline-profiles.ts", () => ({ withPreparedProfile: vi.fn() }));
vi.mock("../../../../src/core/execution/ci/support/ci-execution.mjs", () => ({ executeCITargets: vi.fn() }));
vi.mock("../../../../src/core/projects/project-context.ts", () => ({ distributionRoot: () => "/distribution" }));
const roots: string[] = [];
let root: string;
let target: Extract<CITarget, { kind: "native" }>;
const executePreparedProfile = vi.fn<Parameters<Parameters<typeof withPreparedProfile>[3]>[0]>();
const image: AcquiredCIImage = {
  version: 1,
  profile: "native",
  platform: process.arch === "arm64" ? "linux-arm64" : "linux-x64",
  inputs: "a".repeat(64),
  image: `sha256:${"b".repeat(64)}`,
  reference: "registry.example/group/project/native:inputs",
  published: `registry.example/group/project/native@sha256:${"c".repeat(64)}`,
};
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
  vi.mocked(withPreparedProfile).mockImplementation((_root, _profile, _options, action) =>
    action(executePreparedProfile),
  );
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
    expect(withPreparedProfile).not.toHaveBeenCalled();
    expect(installContainerTools).not.toHaveBeenCalled();
    expect(executeCITargets).not.toHaveBeenCalled();
  },
);
test.skipIf(process.platform !== "linux")(
  "prepared targets require complete results for the selected target",
  async () => {
    vi.mocked(readConfig).mockReturnValue({ ci: { images: { native: "native" } } });
    vi.mocked(acquireCIImage).mockResolvedValue(image);
    executePreparedProfile.mockImplementation((_command, options) => {
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
            required(executePreparedProfile.mock.calls[0]?.[1]?.reports, "Expected retained image report"),
            "image.json",
          ),
          "utf8",
        ),
      ) as unknown,
    ).toEqual(image);
    expect(executeCITargets).not.toHaveBeenCalled();
    executePreparedProfile.mockImplementation((_command, options) => {
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
    const executions = executePreparedProfile.mock.calls.length;
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(
      /companion acquisition failed/,
    );
    expect(executePreparedProfile.mock.calls.length).toBe(executions);
    executePreparedProfile.mockResolvedValueOnce();
    await expect(runHostedCITarget(root, target.id, "gitlab", "reports")).rejects.toThrow(/ENOENT/);
  },
);

test.each([CIOperation.Checks, CIOperation.Release])(
  "prepared %s reuse selected inputs and preserve release evidence",
  async (operation) => {
    const selected: CITarget = { ...target, path: "selected-root", toolchain: "alternate" };
    const candidate = join(root, "candidate");
    mkdirSync(candidate);
    writeFileSync(join(candidate, "archive"), "exact tested candidate");
    executePreparedProfile.mockImplementation((_command, options) => {
      const reports = required(options?.reports, "Expected guest reports");
      const report = createRunReport([selected.id], reports);
      for (const result of report.targets) {
        result.success = true;
        result.started = result.finished = new Date().toISOString();
        delete result.error;
      }
      writeRunReport(join(reports, "guest-results.json"), report);
      const packaged = join(reports, "candidate", "archive");
      if (operation === CIOperation.Release) {
        expect(options?.env?.WORKBENCH_CI_CANDIDATE).toBe("/reports/candidate");
        expect(readFileSync(packaged, "utf8")).toBe("exact tested candidate");
      } else {
        expect(options?.env?.WORKBENCH_CI_CANDIDATE).toBeUndefined();
        expect(existsSync(packaged)).toBe(false);
      }
      return Promise.resolve();
    });
    await executeHostedCISelection(root, [selected], "reports", { operation, profile: "native", image, candidate });
    expect(withPreparedProfile).toHaveBeenCalledExactlyOnceWith(
      root,
      "native",
      { image: image.image, selections: [{ path: "selected-root", toolchain: "alternate" }] },
      expect.any(Function),
    );
    expect(
      executePreparedProfile.mock.calls.map(([, options]) => [
        options?.network,
        options?.env?.WORKBENCH_CI_CHECK_NETWORK,
      ]),
    ).toEqual(
      operation === CIOperation.Checks
        ? [
            ["none", "offline"],
            ["host", "online"],
          ]
        : [["none", "offline"]],
    );
  },
);

test("an online failure fails the combined target and retains both partition reports", async () => {
  const reports = join(root, "local-rehearsal");
  const began = new Date("2026-01-01T00:00:00Z").toISOString();
  const online = new Date("2026-01-01T00:01:00Z").toISOString();
  executePreparedProfile.mockImplementation((_command, options) => {
    const directory = required(options?.reports, "Expected guest reports");
    const result = createRunReport([target.id], directory);
    const outcome = required(result.targets[0], "Expected a target result");
    outcome.success = options?.network === "none";
    outcome.started = outcome.success ? began : online;
    outcome.finished = online;
    if (outcome.success) delete outcome.error;
    else outcome.error = "Locked dependency advisory failed";
    writeRunReport(join(directory, "guest-results.json"), result);
    return outcome.success ? Promise.resolve() : Promise.reject(new Error("Container exited with status 1"));
  });
  const run = await executePreparedCISelection(root, [target], reports, {
    profile: image.profile,
    image: image.image,
    operation: CIOperation.Checks,
  });
  const result = required(run.targets[0], "Expected one combined target");
  expect(run.errors).toEqual([]);
  expect(result).toMatchObject({
    success: false,
    started: began,
    finished: online,
    error: "Locked dependency advisory failed",
  });
  for (const partition of ["offline", "online"])
    expect(existsSync(join(result.report, partition, "guest-results.json"))).toBe(true);
});
