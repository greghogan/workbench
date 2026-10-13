import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nativeAssetPruningPlan, pruneNativeAssets, publishNativeAssets } from "../src/native-asset-maintenance.ts";
import { packageManagerCommand, packageManagerInstallationPlan } from "../src/package-manager.ts";
import { userDirectory } from "../src/storage.ts";

vi.mock("../src/tool-downloads.js", () => ({ execute: vi.fn() }));
import { execute } from "../src/tool-downloads.ts";

const repository = resolve(import.meta.dirname, "..");
const pnpmVersion = JSON.parse(readFileSync(join(repository, "scripts/package-manager/package.json"), "utf8"))
  .dependencies.pnpm;
const temporary = [];
beforeEach(() => vi.stubEnv("WORKBENCH_CACHE_HOME", join(fixture(), "cache")));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-bootstrap-maintenance-"));
  temporary.push(root);
  return root;
}
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

test("native metadata pruning retains native, bootstrap and compiler support pins on every host", () => {
  // Existing reference roots include both compiler families and independently pinned C/C++ toolchains.
  expect(pruneNativeAssets(repository, true)).toEqual([]);
  const root = fixture();
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="test"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
  );
  writeFileSync(join(root, ".node-version"), "24.21.0\n");
  writeFileSync(join(root, ".tool-versions"), "uv 0.12.23\n");
  writeJson(join(root, "scripts/bootstrap-tools.json"), { "rustup-init": "1.29.1" });
  const required = {
    node: { "24.21.0": { "linux-x64": { sha256: "retained" }, "darwin-arm64": { sha256: "also retained" } } },
    uv: { "0.12.23": {} },
    "rustup-init": { "1.29.1": {} },
  };
  const path = join(root, "scripts/native-assets.json");
  writeJson(path, { ...required, node: { ...required.node, "24.20.0": {} }, unused: { "1.0.0": {} }, empty: {} });
  const original = readFileSync(path, "utf8");
  expect(() => pruneNativeAssets(root, true)).toThrow(/obsolete native assets/);
  expect(readFileSync(path, "utf8")).toBe(original);
  const plan = nativeAssetPruningPlan(root);
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(() => publishNativeAssets(root, plan.original, JSON.stringify({}))).toThrow(/differs from the pruning plan/);
  expect(readFileSync(path, "utf8")).toBe(original);
  writeFileSync(path, `${original}\n`);
  expect(() => publishNativeAssets(root, plan.original, JSON.stringify(plan.inventory))).toThrow(
    /changed during pruning/,
  );
  writeFileSync(path, original);
  expect(pruneNativeAssets(root)).toEqual(["node@24.20.0", "unused@1.0.0", "empty"]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(required);
  expect(pruneNativeAssets(root)).toEqual([]);
  const unchanged = nativeAssetPruningPlan(root);
  const formatted = JSON.stringify(unchanged.inventory);
  expect(publishNativeAssets(root, unchanged.original, formatted)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(formatted);
  writeJson(path, { ...required, uv: {} });
  const incomplete = readFileSync(path, "utf8");
  expect(() => pruneNativeAssets(root)).toThrow(/missing required uv/);
  expect(readFileSync(path, "utf8")).toBe(incomplete);
});

test("npm bootstraps the package manager from committed hashes outside the project and reuses the installation", () => {
  const root = fixture();
  writeJson(join(root, "package.json"), { packageManager: `pnpm@${pnpmVersion}` });
  const npm = vi.mocked(execute);
  npm.mockImplementation((command, _args, options) => {
    if (command === "cygpath") return _args.at(-1);
    if (command === "env") return pnpmVersion;
    const directory = join(options.cwd, "node_modules/pnpm/bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pnpm.mjs"), "fixture");
  });
  const command = packageManagerCommand(root, repository);
  expect(command.slice(0, 2)).toEqual(["env", "COREPACK_ENABLE_NETWORK=0"]);
  expect(command[2]).toContain(`PATH=${join(userDirectory("cache"), "package-managers")}`);
  expect(command[3]).toBe(process.execPath);
  expect(command[4].startsWith(join(userDirectory("cache"), "package-managers"))).toBe(true);
  expect(readFileSync(join(packageManagerInstallationPlan(root, repository).directory, "bin/pnpm"), "utf8")).toContain(
    "../node_modules/pnpm/bin/pnpm.mjs",
  );
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  expect(npm).toHaveBeenCalledWith(
    "npm",
    ["ci", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
    expect.anything(),
  );
  expect(npm).toHaveBeenCalledWith("npm", ["audit", "signatures"], expect.anything());
  const acquisitions = npm.mock.calls.filter(([command]) => command === "npm");
  expect(packageManagerCommand(root, repository)).toEqual(command);
  expect(npm.mock.calls.filter(([command]) => command === "npm")).toEqual(acquisitions);
  vi.stubEnv("WORKBENCH_OFFLINE", "1");
  expect(packageManagerCommand(root, repository)).toEqual([
    ...command.slice(0, 2),
    "PNPM_CONFIG_OFFLINE=true",
    ...command.slice(2),
  ]);
  expect(npm.mock.calls.filter(([command]) => command === "npm")).toEqual(acquisitions);
  vi.stubEnv("WORKBENCH_OFFLINE", undefined);
  const local = join(root, "workbench/package-manager");
  mkdirSync(local, { recursive: true });
  cpSync(join(repository, "scripts/package-manager"), local, { recursive: true });
  const lockPath = join(local, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  delete lock.packages["node_modules/pnpm"].integrity;
  writeJson(lockPath, lock);
  expect(() => packageManagerCommand(root, repository)).toThrow(/recorded strong integrity hash/);
  expect(npm.mock.calls.filter(([command]) => command === "npm")).toEqual(acquisitions);
  writeJson(join(root, "package.json"), { packageManager: "pnpm@12.7.0" });
  expect(() => packageManagerCommand(root, repository)).toThrow(/bootstrap lock must match/);
});

test.each(["integrity", "signature", "version"])(
  "a failed %s check leaves no partial package-manager activation",
  (failure) => {
    const root = fixture();
    writeJson(join(root, "package.json"), { packageManager: `pnpm@${pnpmVersion}` });
    let staging;
    vi.mocked(execute).mockImplementation((command, args, options) => {
      if (command === "npm" && args[0] === "ci") {
        staging = options.cwd;
        if (failure === "integrity") throw new Error("npm EINTEGRITY");
      }
      if (command === "npm" && args[0] === "audit" && failure === "signature")
        throw new Error("npm signature verification failed");
      return "12.0.0";
    });
    expect(() => packageManagerCommand(root, repository)).toThrow(
      failure === "integrity"
        ? /EINTEGRITY/
        : failure === "signature"
          ? /signature verification/
          : `expected pnpm ${pnpmVersion}`,
    );
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(staging.replace(/\.[^.]+\.partial$/, ""))).toBe(false);
  },
);
