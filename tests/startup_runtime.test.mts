import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { restartWithStartupRuntime } from "../src/startup-runtime.ts";
import { ownsStartupRuntime } from "../src/launcher.ts";
import * as assets from "../src/native-assets.ts";
import { installAsset } from "../src/tool-downloads.ts";
import { launchProcess } from "../src/launcher.ts";
import { inspectToolCacheActivity } from "../src/tool-cache-lock.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), existsSync: vi.fn(actual.existsSync) };
});
const realRead = vi.mocked(readFileSync).getMockImplementation(),
  realExists = vi.mocked(existsSync).getMockImplementation();
vi.mock("../src/native-assets.ts", async (original) => ({
  ...(await original<typeof import("../src/native-assets.ts")>()),
  assetFor: vi.fn<typeof import("../src/native-assets.ts").assetFor>(),
  toolDirectory: vi.fn<typeof import("../src/native-assets.ts").toolDirectory>(),
}));
vi.mock("../src/tool-downloads.ts", async (original) => ({
  ...(await original<typeof import("../src/tool-downloads.ts")>()),
  installAsset: vi.fn<typeof import("../src/tool-downloads.ts").installAsset>(),
}));
vi.mock("../src/launcher.ts", async (original) => ({
  ...(await original<typeof import("../src/launcher.ts")>()),
  launchProcess: vi.fn<typeof import("../src/launcher.ts").launchProcess>(),
}));
const temporary: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.mocked(readFileSync).mockImplementation(required(realRead, "Expected fixture value"));
  vi.mocked(existsSync).mockImplementation(required(realExists, "Expected fixture value"));
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(version = "99.1.0") {
  for (const key of ["GUIX_ENVIRONMENT", "IN_NIX_SHELL", "WORKBENCH_COMPATIBILITY_RUNTIME"]) vi.stubEnv(key, undefined);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-startup-")));
  temporary.push(directory);
  writeFileSync(join(directory, ".node-version"), version);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(directory, "cache"));
  const installation = join(directory, "sdk"),
    executable = join(installation, "bin", process.platform === "win32" ? "node.exe" : "node"),
    asset = {
      url: "https://example.invalid/node.tar.gz",
      sha256: "a".repeat(64),
      bin: "bin",
      format: "tar" as const,
      strip: 1,
    };
  vi.mocked(assets.assetFor).mockReturnValue(asset);
  vi.mocked(assets.toolDirectory).mockReturnValue(installation);
  return { directory, installation, executable, asset };
}

test("native startup installs and dispatches the pinned runtime under an active tool lease", async () => {
  const f = fixture();
  const assertLease = () => {
    expect(inspectToolCacheActivity().uses).toEqual([
      expect.objectContaining({ tools: [{ tool: "node", version: "99.1.0", directory: f.installation }] }),
    ]);
  };
  vi.mocked(installAsset).mockImplementation((directory: string, asset) =>
    promised(() => {
      assertLease();
      expect(directory).toBe(f.installation);
      expect(asset).toBe(f.asset);
      mkdirSync(directory);
      writeFileSync(join(directory, "verified"), "ready");
    }),
  );
  vi.mocked(launchProcess).mockImplementation((executable, args) =>
    promised(() => {
      assertLease();
      expect(existsSync(join(f.installation, "verified"))).toBe(true);
      expect(executable).toBe(f.executable);
      expect(args).toEqual([
        ...process.execArgv,
        resolve(required(process.argv[1], "Expected fixture value")),
        ...process.argv.slice(2),
      ]);
    }),
  );
  expect(await restartWithStartupRuntime(f.directory)).toBe(true);
  expect(assets.assetFor).toHaveBeenCalledWith(
    f.directory,
    expect.objectContaining({ name: "node", version: "99.1.0" }),
  );
  expect(launchProcess).toHaveBeenCalledOnce();
  expect(inspectToolCacheActivity().uses).toEqual([]);
});

test("a verified running runtime needs no installation, re-execution, or cache writes", async () => {
  const f = fixture(process.versions.node);
  const installation = resolve(dirname(realpathSync(process.execPath)), process.platform === "win32" ? "." : "..");
  const receipt = join(installation, ".workbench-artifact");
  f.asset.bin = process.platform === "win32" ? "." : "bin";
  vi.mocked(existsSync).mockImplementation(
    (path) => path === receipt || required(realExists, "Expected fixture value: realExists")(path),
  );
  vi.mocked(readFileSync).mockImplementation((path, ...args) =>
    path === receipt ? f.asset.sha256 : required(realRead, "Expected fixture value")(path, ...args),
  );
  expect(await restartWithStartupRuntime(f.directory)).toBe(false);
  expect(installAsset).not.toHaveBeenCalled();
  expect(launchProcess).not.toHaveBeenCalled();
  expect(existsSync(join(f.directory, "cache"))).toBe(false);
});

test("the correct version without a matching artifact receipt still selects the controlled runtime", async () => {
  const f = fixture(process.versions.node);
  vi.mocked(existsSync).mockImplementation((path) =>
    String(path).endsWith(".workbench-artifact") ? false : required(realExists, "Expected fixture value")(path),
  );
  expect(await restartWithStartupRuntime(f.directory)).toBe(true);
  expect(installAsset).toHaveBeenCalledWith(f.installation, f.asset);
  expect(launchProcess).toHaveBeenCalledOnce();
});

test("an invalid runtime at the selected destination fails instead of repeatedly restarting", async () => {
  const f = fixture();
  f.asset.bin = process.platform === "win32" ? "." : "bin";
  vi.mocked(assets.toolDirectory).mockReturnValue(
    resolve(dirname(realpathSync(process.execPath)), f.asset.bin === "." ? "." : ".."),
  );
  await expect(restartWithStartupRuntime(f.directory)).rejects.toThrow(/invalid Workbench startup Node/);
  expect(installAsset).not.toHaveBeenCalled();
  expect(launchProcess).not.toHaveBeenCalled();
});

test.each([
  { GUIX_ENVIRONMENT: "/gnu/store/profile" },
  { IN_NIX_SHELL: "pure" },
  { WORKBENCH_SHELL_ENVIRONMENT: "guix" },
  { WORKBENCH_SHELL_ENVIRONMENT: "nix" },
  { WORKBENCH_PREPARED: "1" },
  { WORKBENCH_DEVCONTAINER: "1" },
  { WORKBENCH_COMPATIBILITY_RUNTIME: "node", WORKBENCH_COMPATIBILITY_VERSION: "22.23.3" },
])("selected environment retains runtime: %j", async (env) => {
  expect(ownsStartupRuntime(env)).toBe(false);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(await restartWithStartupRuntime("/must-not-be-read")).toBe(false);
  expect(assets.assetFor).not.toHaveBeenCalled();
  expect(installAsset).not.toHaveBeenCalled();
  expect(launchProcess).not.toHaveBeenCalled();
});

test("a native shell and compatibility for another language still select Workbench's Node", () => {
  expect(ownsStartupRuntime({})).toBe(true);
  expect(ownsStartupRuntime({ WORKBENCH_SHELL_ENVIRONMENT: "native" })).toBe(true);
  expect(ownsStartupRuntime({ WORKBENCH_COMPATIBILITY_RUNTIME: "python" })).toBe(true);
  expect(ownsStartupRuntime({ GUIX_PROFILE: "/home/user/.guix-profile" })).toBe(true);
});

test.each(["installation", "execution"])(
  "startup %s failure releases the tool lease and never falls back",
  async (phase) => {
    const f = fixture();
    const error = new Error(`${phase} failed`);
    vi.mocked(phase === "installation" ? installAsset : launchProcess).mockRejectedValue(error);
    await expect(restartWithStartupRuntime(f.directory)).rejects.toBe(error);
    expect(inspectToolCacheActivity().uses).toEqual([]);
    expect(launchProcess).toHaveBeenCalledTimes(phase === "installation" ? 0 : 1);
  },
);

test("missing authenticated runtime metadata fails before acquisition or command execution", async () => {
  const f = fixture();
  vi.mocked(assets.assetFor).mockReturnValue(undefined);
  await expect(restartWithStartupRuntime(f.directory)).rejects.toThrow(/no verified Workbench startup Node/);
  expect(installAsset).not.toHaveBeenCalled();
  expect(launchProcess).not.toHaveBeenCalled();
});
