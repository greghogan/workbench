import { promised } from "./fixtures/promised.mjs";
import { AcquisitionRejected, AcquisitionReason } from "../scripts/network-retry.mts";
import { acquireCommand } from "../scripts/network-command.mts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acquireCIImage, restoreCIImage, verifyCIImages } from "../src/ci-images.ts";
import { readConfig } from "../src/project-configuration.ts";
import { ciTargets } from "../src/ci-targets.ts";
import { offlineProfile, offlineInputs, offlineImageReference } from "../src/offline-profiles.ts";
import { registryImageStatus } from "../src/registry-images.ts";
import { executeCI } from "../scripts/ci-lifecycle.mjs";

vi.mock("../scripts/network-command.mts", () => ({ acquireCommand: vi.fn() }));
vi.mock("../src/project-configuration.ts", () => ({ readConfig: vi.fn() }));
vi.mock("../src/ci-targets.ts", () => ({ ciTargets: vi.fn() }));
vi.mock("../src/offline-profiles.ts", () => ({
  offlineProfile: vi.fn(),
  offlineInputs: vi.fn(),
  offlineImageReference: vi.fn(),
}));
vi.mock("../src/registry-images.ts", () => ({ registryImageStatus: vi.fn() }));
vi.mock("../scripts/ci-lifecycle.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/ci-lifecycle.mjs")>()),
  executeCI: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.mocked(readConfig).mockReturnValue({ ci: { images: { native: "native", nix: "nix" } } });
  vi.mocked(offlineProfile).mockImplementation((_root, name) => ({
    name,
    builder: name === "nix" ? "nix" : "native",
    workspace: "devcontainer",
    offline: { inputs: [], verify: [], registry: `ghcr.io/fixture/${name}` },
  }));
  vi.mocked(offlineInputs).mockReturnValue("a".repeat(64));
  vi.mocked(offlineImageReference).mockImplementation(
    (_root, name, architecture = process.arch) => `ghcr.io/fixture/${name}:linux-${architecture}-inputs`,
  );
  vi.mocked(registryImageStatus).mockResolvedValue({ state: "available" });
  const target = (
    architecture: string,
    environment = "native",
    os = "linux",
  ): ReturnType<typeof ciTargets>[number] => ({
    id: `${os}-${architecture}-${environment}`,
    path: ".",
    kind: environment === "native" ? "native" : "environment",
    os,
    architecture,
    environment,
    checks: [],
    phases: [],
    release: false,
  });
  vi.mocked(ciTargets).mockReturnValue([
    target("x64"),
    target("x64"),
    target("arm64"),
    target("x64", "nix"),
    target("arm64", "native", "macos"),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test("availability covers the configured image platforms once without acquiring or building layers", async () => {
  await verifyCIImages("/fixture");
  expect(vi.mocked(registryImageStatus).mock.calls.map(([reference]) => reference)).toEqual([
    "ghcr.io/fixture/native:linux-x64-inputs",
    "ghcr.io/fixture/native:linux-arm64-inputs",
    "ghcr.io/fixture/nix:linux-x64-inputs",
  ]);
  expect(executeCI).not.toHaveBeenCalled();
});

test("missing images and unavailable registries block the push with actionable distinctions", async () => {
  vi.mocked(registryImageStatus).mockImplementation((reference) =>
    promised(() =>
      reference.includes("native:linux-arm64")
        ? { state: "missing" }
        : reference.includes("/nix:")
          ? { state: "unavailable", detail: "access denied" }
          : { state: "available" },
    ),
  );
  await expect(verifyCIImages("/fixture")).rejects.toThrow(/native \(linux-arm64\): published image is missing/);
  await expect(verifyCIImages("/fixture")).rejects.toThrow(
    /nix \(linux-x64\): registry availability could not be verified: access denied/,
  );
  await expect(verifyCIImages("/fixture")).rejects.toThrow(/Local foreign execution requires configured binfmt/);
  expect(executeCI).not.toHaveBeenCalled();
});

test("projects without prepared CI images need no registry client", async () => {
  vi.mocked(readConfig).mockReturnValue({});
  await verifyCIImages("/fixture");
  expect(ciTargets).not.toHaveBeenCalled();
  expect(registryImageStatus).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "CI image acquisition fails on missing publication without running preparation",
  async () => {
    vi.mocked(acquireCommand).mockRejectedValue(
      new AcquisitionRejected("manifest unknown", undefined, AcquisitionReason.Missing),
    );
    await expect(acquireCIImage("/fixture", "native")).rejects.toThrow(/CI does not rebuild prepared images/);
    expect(acquireCommand).toHaveBeenCalledOnce();
    expect(executeCI).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "transferred images restore the exact published digest and reject stale inputs or changed image identities",
  async () => {
    const published = `ghcr.io/fixture/native@sha256:${"c".repeat(64)}`;
    const handoff = {
      version: 1 as const,
      profile: "native",
      platform: process.arch === "x64" ? ("linux-x64" as const) : ("linux-arm64" as const),
      inputs: "a".repeat(64),
      reference: `ghcr.io/fixture/native:linux-${process.arch}-inputs`,
      image: `sha256:${"b".repeat(64)}`,
      published,
    };
    const inspected = {
      Id: handoff.image,
      Os: "linux",
      Architecture: process.arch === "x64" ? "amd64" : "arm64",
      RepoDigests: [`ghcr.io/fixture/native@sha256:${"d".repeat(64)}`, published],
      Config: { Labels: { "org.workbench.inputs": handoff.inputs, "org.workbench.builder": "native" } },
    };
    vi.mocked(acquireCommand).mockResolvedValue("");
    vi.mocked(executeCI).mockImplementation((_command, args) =>
      Promise.resolve(args[0] === "pull" ? "" : JSON.stringify(inspected)),
    );
    await expect(restoreCIImage("/fixture", "native", handoff)).resolves.toMatchObject(handoff);
    expect(vi.mocked(acquireCommand).mock.calls[0]?.slice(1, 3)).toEqual(["docker", ["pull", published]]);
    vi.mocked(executeCI).mockClear();
    await expect(restoreCIImage("/fixture", "native", { ...handoff, inputs: "e".repeat(64) })).rejects.toThrow(
      /current inputs/,
    );
    expect(executeCI).not.toHaveBeenCalled();
    inspected.Id = `sha256:${"f".repeat(64)}`;
    await expect(restoreCIImage("/fixture", "native", handoff)).rejects.toThrow(/differs from verified preparation/);
  },
);
