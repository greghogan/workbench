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
beforeEach(() => {
  // Explicit consumer compatibility selections; reference examples only run their development release.
  vi.spyOn(ci, "ciMatrix").mockReturnValue({
    compatibility: {
      include: [
        { path: ".", runtime: "node", version: "22.23.3" },
        { path: "examples/languages/go", runtime: "go", version: "1.27.1" },
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
  vi.spyOn(builds, "prepareBuild").mockImplementation(() => {});
  vi.spyOn(builds, "withBuildLock").mockImplementation((_paths, action) => action());
  vi.spyOn(native, "verifyInstalledTool").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test.each([
  [".", "node", "22.23.3"],
  ["examples/languages/go", "go", "1.27.1"],
  ["examples/languages/java", "java", "25.0.4.1+1"],
])("compatibility %s %s installs and probes the selected artifact before execution", async (path, runtime, version) => {
  vi.spyOn(builds, "prepareBuild").mockImplementation(() => {});
  vi.spyOn(builds, "withBuildLock").mockImplementation((_paths, action) => action());
  const install = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  const probe = vi.spyOn(native, "verifyInstalledTool").mockImplementation(() => {});
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({ PATH: "/development/bin" });
  const execute = vi.spyOn(downloads, "execute").mockReturnValue("");
  const plan = compatibilityRuntimePlan(repository, path, runtime, version);
  await executeCompatibilityRuntime(repository, path, runtime, version, [runtime, "--version"]);
  expect(install).toHaveBeenCalledWith(plan.directory, plan.asset);
  expect(probe).toHaveBeenCalledWith(resolve(repository, path), plan.tool, plan.asset, plan.directory, {
    ...executionEnvironment(repository),
    PATH: `${join(plan.directory, plan.asset.bin)}${delimiter}/development/bin`,
    ...(runtime === "go"
      ? {
          GOROOT: plan.directory,
          GOTOOLCHAIN: "local",
          GOFLAGS: `${executionEnvironment(repository).GOFLAGS} -mod=readonly`,
        }
      : {}),
    ...(runtime === "java" ? { JAVA_HOME: resolve(plan.directory, plan.asset.bin, "..") } : {}),
  });
  const options = execute.mock.calls[0][2];
  expect(options.cwd).toBe(repository);
  expect(options.env.PATH).toBe(`${join(plan.directory, plan.asset.bin)}${delimiter}/development/bin`);
  if (runtime === "go") expect(options.env.GOROOT).toBe(plan.directory);
  expect(install.mock.invocationCallOrder[0]).toBeLessThan(probe.mock.invocationCallOrder[0]);
  expect(probe.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
});

test("Rust compatibility installs its selected toolchain and rejects missing commands and undeclared targets", async () => {
  const target = ci.ciMatrix(repository).compatibility.include.find(({ runtime }) => runtime === "rust");
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({ PATH: "/development/bin" });
  const bootstrap = vi
    .spyOn(native, "ensureRustup")
    .mockImplementation(async (_distribution, env) => ({ ...env, PATH: "/rustup/bin" }));
  const install = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  const execute = vi.spyOn(downloads, "execute").mockReturnValue("");
  await executeCompatibilityRuntime(repository, target.path, "rust", target.version, ["rustup", "--version"]);
  expect(bootstrap).toHaveBeenCalledWith(repository, { PATH: "/development/bin", ...executionEnvironment(repository) });
  expect(install).not.toHaveBeenCalled();
  expect(native.verifyInstalledTool).toHaveBeenCalledWith(
    resolve(repository, target.path),
    expect.objectContaining({ name: "rust" }),
    undefined,
    undefined,
    expect.objectContaining({ RUSTUP_TOOLCHAIN: target.version }),
    "compatibility",
  );
  expect(
    toolProbes({ name: "rust", version: target.version, source: "test" }, "compatibility").map((p) => p.executable),
  ).toEqual(["rustc", "cargo"]);
  expect(execute.mock.calls.at(-1)[2].env.PATH).toBe("/rustup/bin");
  expect(execute.mock.calls.at(-1)[2].env.WORKBENCH_CPUS).toBe(executionEnvironment(repository).WORKBENCH_CPUS);
  expect(execute.mock.calls.at(-1)[2].env.RUSTUP_TOOLCHAIN).toBe(target.version);
  expect(execute.mock.calls[0].slice(0, 2)).toEqual([
    "rustup",
    ["toolchain", "install", target.version, "--no-self-update", "--profile", "minimal"],
  ]);
  await expect(executeCompatibilityRuntime(repository, target.path, "rust", target.version, [])).rejects.toThrow(
    /requires a command/,
  );
  await expect(executeCompatibilityRuntime(repository, target.path, "rust", "0.0.0", ["rustup"])).rejects.toThrow(
    /not a configured/,
  );
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
  expect(execute.mock.calls[0].slice(0, 2)).toEqual(["uv", ["python", "install", "3.11.17"]]);
  expect(native.verifyInstalledTool).toHaveBeenCalledWith(
    resolve(repository, path),
    expect.objectContaining({ name: "python", version: "3.11.17" }),
    undefined,
    undefined,
    expect.objectContaining({ UV_PYTHON_DOWNLOADS: "never", WORKBENCH_PYTHON: "/managed/python311/bin/python" }),
  );
  expect(execute.mock.calls.at(-1)[2].env).toMatchObject({
    UV_PYTHON: "3.11.17",
    WORKBENCH_COMPATIBILITY_VERSION: "3.11.17",
  });
});
