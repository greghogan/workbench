import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as builds from "../src/builds.ts";
import * as downloads from "../src/tool-downloads.ts";
import * as native from "../src/native-tools.ts";
import { compatibilityRuntimePlan, executeCompatibilityRuntime } from "../src/ci-runtime.ts";
import * as ci from "../src/ci.ts";
import { executionEnvironment } from "../src/execution-resources.ts";
import { toolProbes } from "../src/tool-probes.ts";
import * as assets from "../src/native-assets.ts";

const repository = resolve(import.meta.dirname, "..");
const lockOwner = { beforeSpawn: () => undefined, spawned: () => undefined, release: () => undefined };
beforeEach(() => {
  // Explicit consumer compatibility selections; reference examples only run their development release.
  vi.spyOn(ci, "ciMatrix").mockReturnValue({
    native: { include: [] },
    environments: { include: [] },
    devcontainer: { paths: [] },
    compatibility: {
      include: [
        { path: ".", runtime: "node", version: "22.23.4" },
        { path: "examples/languages/go", runtime: "go", version: "1.27.3" },
        { path: "examples/languages/java", runtime: "java", version: "25.0.4.1+1" },
        { path: "examples/languages/rust", runtime: "rust", version: "1.94.0" },
        { path: "examples/languages/python", runtime: "python", version: "3.11.17" },
      ],
    },
  });
  // Installation is mocked; use the configured Linux x64 target's actual artifact metadata on every test host.
  const assetFor = assets.assetFor;
  vi.spyOn(assets, "assetFor").mockImplementation((root, tool, directory) =>
    assetFor(root, tool, directory, "linux-x64"),
  );
  vi.spyOn(native, "installNativeTools").mockResolvedValue(undefined);
  vi.spyOn(builds, "prepareBuild").mockImplementation(() => undefined);
  vi.spyOn(builds, "withBuildLock").mockImplementation((_paths, action) => action(lockOwner));
  vi.spyOn(native, "verifyInstalledTool").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test.each([
  [".", "node", "22.23.4"],
  ["examples/languages/go", "go", "1.27.3"],
  ["examples/languages/java", "java", "25.0.4.1+1"],
])("compatibility %s %s installs and probes the selected artifact before execution", async (path, runtime, version) => {
  vi.spyOn(builds, "prepareBuild").mockImplementation(() => undefined);
  vi.spyOn(builds, "withBuildLock").mockImplementation((_paths, action) => action(lockOwner));
  const install = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  const probe = vi.spyOn(native, "verifyInstalledTool").mockImplementation(() => undefined);
  vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
  vi.stubEnv("GOFLAGS", "-tags=ambient");
  vi.spyOn(native, "nativeEnvironment").mockImplementation((_directory, _distribution, _selection, base) => ({
    ...base,
    PATH: "/development/bin",
  }));
  const execute = vi.spyOn(downloads, "execute").mockReturnValue("");
  const plan = compatibilityRuntimePlan(repository, path, runtime, version);
  await executeCompatibilityRuntime(repository, path, runtime, version, [runtime, "--version"]);
  expect(install).toHaveBeenCalledWith(plan.directory, plan.asset);
  expect(probe).toHaveBeenCalledWith(
    resolve(repository, path),
    plan.tool,
    plan.asset,
    plan.directory,
    expect.objectContaining({
      WORKBENCH_CPU_BUDGET: executionEnvironment(repository).WORKBENCH_CPU_BUDGET,
      PATH: `${join(required(plan.directory, "Fixture value plan.directory"), required(plan.asset, "Expected fixture value: plan.asset").bin)}${delimiter}/development/bin`,
      ...(runtime === "go"
        ? {
            GOROOT: plan.directory,
            GOTOOLCHAIN: "local",
            GOFLAGS: `-p=${String(executionEnvironment(repository).WORKBENCH_CPU_BUDGET)} -mod=readonly`,
          }
        : {}),
      ...(runtime === "java"
        ? {
            JAVA_HOME: resolve(
              required(plan.directory, "Fixture value plan.directory"),
              required(plan.asset, "Expected fixture value: plan.asset").bin,
              "..",
            ),
          }
        : {}),
    }),
  );
  const options = required(execute.mock.calls[0], "Expected fixture value: execute.mock.calls[0]")[2];
  expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
  expect(options?.env?.GOFLAGS ?? "").not.toContain("ambient");
  expect(required(options, "Expected fixture value: options").cwd).toBe(repository);
  expect(
    required(required(options, "Expected fixture value: options").env, "Expected fixture value: options.env").PATH,
  ).toBe(
    `${join(required(plan.directory, "Fixture value plan.directory"), required(plan.asset, "Expected fixture value: plan.asset").bin)}${delimiter}/development/bin`,
  );
  if (runtime === "go")
    expect(
      required(required(options, "Expected fixture value: options").env, "Expected fixture value: options.env").GOROOT,
    ).toBe(plan.directory);
  expect(install.mock.invocationCallOrder[0]).toBeLessThan(
    required(probe.mock.invocationCallOrder[0], "Fixture value probe.mock.invocationCallOrder[0]"),
  );
  expect(probe.mock.invocationCallOrder[0]).toBeLessThan(
    required(execute.mock.invocationCallOrder[0], "Fixture value execute.mock.invocationCallOrder[0]"),
  );
});

test("Rust compatibility installs its selected toolchain and rejects missing commands and undeclared targets", async () => {
  const target = ci.ciMatrix(repository).compatibility.include.find(({ runtime }) => runtime === "rust");
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({ PATH: "/development/bin" });
  const bootstrap = vi
    .spyOn(native, "ensureRustup")
    .mockImplementation((_distribution, env) => promised(() => ({ ...env, PATH: "/rustup/bin" })));
  const install = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  const execute = vi.spyOn(downloads, "execute").mockReturnValue("");
  await executeCompatibilityRuntime(
    repository,
    required(target, "Expected fixture value: target").path,
    "rust",
    required(target, "Expected fixture value: target").version,
    ["rustup", "--version"],
  );
  expect(bootstrap).toHaveBeenCalledWith(
    repository,
    expect.objectContaining({
      PATH: "/development/bin",
      WORKBENCH_CPU_BUDGET: executionEnvironment(repository).WORKBENCH_CPU_BUDGET,
    }),
  );
  expect(install).not.toHaveBeenCalled();
  expect(native.verifyInstalledTool).toHaveBeenCalledWith(
    resolve(repository, required(target, "Expected fixture value: target").path),
    expect.objectContaining({ name: "rust" }),
    undefined,
    undefined,
    expect.objectContaining({ RUSTUP_TOOLCHAIN: required(target, "Expected fixture value: target").version }),
    "compatibility",
  );
  expect(
    toolProbes(
      { name: "rust", version: required(target, "Expected fixture value: target").version, source: "test" },
      "compatibility",
    ).map((p) => p.executable),
  ).toEqual(["rustc", "cargo"]);
  expect(
    required(
      required(
        required(execute.mock.calls.at(-1), "Expected fixture value: execute.mock.calls.at(-1)")[2],
        "Expected fixture value: execute.mock.calls.at(-1)[2]",
      ).env,
      "Expected fixture value: execute.mock.calls.at(-1)[2].env",
    ).PATH,
  ).toBe("/rustup/bin");
  expect(
    required(
      required(
        required(execute.mock.calls.at(-1), "Expected fixture value: execute.mock.calls.at(-1)")[2],
        "Expected fixture value: execute.mock.calls.at(-1)[2]",
      ).env,
      "Expected fixture value: execute.mock.calls.at(-1)[2].env",
    ).WORKBENCH_CPU_BUDGET,
  ).toBe(executionEnvironment(repository).WORKBENCH_CPU_BUDGET);
  expect(
    required(
      required(
        required(execute.mock.calls.at(-1), "Expected fixture value: execute.mock.calls.at(-1)")[2],
        "Expected fixture value: execute.mock.calls.at(-1)[2]",
      ).env,
      "Expected fixture value: execute.mock.calls.at(-1)[2].env",
    ).RUSTUP_TOOLCHAIN,
  ).toBe(required(target, "Expected fixture value: target").version);
  expect(required(execute.mock.calls[0], "Expected fixture value: execute.mock.calls[0]").slice(0, 2)).toEqual([
    "rustup",
    [
      "toolchain",
      "install",
      required(target, "Expected fixture value: target").version,
      "--no-self-update",
      "--profile",
      "minimal",
    ],
  ]);
  await expect(
    executeCompatibilityRuntime(
      repository,
      required(target, "Expected fixture value: target").path,
      "rust",
      required(target, "Expected fixture value: target").version,
      [],
    ),
  ).rejects.toThrow(/requires a command/);
  await expect(
    executeCompatibilityRuntime(repository, required(target, "Expected fixture value: target").path, "rust", "0.0.0", [
      "rustup",
    ]),
  ).rejects.toThrow(/not a configured/);
});

test("Python compatibility installs verified uv and only the selected interpreter", async () => {
  const path = "examples/languages/python";
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({ PATH: "/development/bin" });
  const execute = vi
    .spyOn(downloads, "execute")
    .mockImplementation((command, args) =>
      command === "uv" && args[1] === "find" ? "/managed/python311/bin/python\n" : "",
    );
  await executeCompatibilityRuntime(repository, path, "python", "3.11.17", ["python", "--version"]);
  expect(native.installNativeTools).toHaveBeenCalledExactlyOnceWith(repository, path, {}, "uv");
  expect(required(execute.mock.calls[0], "Expected fixture value: execute.mock.calls[0]").slice(0, 2)).toEqual([
    "uv",
    ["python", "install", "3.11.17"],
  ]);
  expect(execute.mock.calls[0]?.[2]?.env?.UV_PYTHON_DOWNLOADS).toBeUndefined();
  expect(native.verifyInstalledTool).toHaveBeenCalledWith(
    resolve(repository, path),
    expect.objectContaining({ name: "python", version: "3.11.17" }),
    undefined,
    undefined,
    expect.objectContaining({ UV_PYTHON_DOWNLOADS: "never", WORKBENCH_PYTHON: "/managed/python311/bin/python" }),
  );
  expect(
    required(
      required(execute.mock.calls.at(-1), "Expected fixture value: execute.mock.calls.at(-1)")[2],
      "Expected fixture value: execute.mock.calls.at(-1)[2]",
    ).env,
  ).toMatchObject({
    UV_PYTHON: "3.11.17",
    UV_PYTHON_DOWNLOADS: "never",
    WORKBENCH_COMPATIBILITY_VERSION: "3.11.17",
  });
});
