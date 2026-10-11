import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { buildEnvironment, buildPaths, prepareBuild } from "../src/builds.ts";

const require = createRequire(import.meta.url);
const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(integrated = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-pnpm-hook-")));
  temporary.push(directory);
  const root = join(directory, "project");
  mkdirSync(root);
  const config = join(directory, "config/config.toml");
  mkdirSync(dirname(config));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", dirname(config));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(directory, "cache"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve("."));
  if (integrated) {
    mkdirSync(join(root, "workbench"));
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
  }
  const load = (path = root) => {
    copyFileSync(resolve(".pnpmfile.cjs"), join(path, ".pnpmfile.cjs"));
    return require(join(path, ".pnpmfile.cjs")).hooks.updateConfig;
  };
  return { root, directory, config, load };
}

test("direct pnpm hooks select external stores from global preferences and complete local overrides", () => {
  const { root, directory, config, load } = fixture();
  writeFileSync(config, `[storage]\nexternal=true\nroot=${JSON.stringify(join(directory, "fast disk"))}\n`);
  const hook = load();
  const result = hook({ nodeLinker: "isolated", registry: "https://example.invalid" });
  const paths = buildPaths(root, root, "native", {}, false);
  expect(result).toEqual({
    nodeLinker: "isolated",
    registry: "https://example.invalid",
    storeDir: paths.pnpmStore,
    virtualStoreDir: join(paths.dependencies, "pnpm"),
    virtualStoreType: "project",
  });
  expect(JSON.parse(readFileSync(join(paths.dependencies, ".workbench-dependencies.json"), "utf8"))).toEqual(
    paths.identity,
  );
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  writeFileSync(join(root, "workbench/local.toml"), "[storage]\nexternal=false\n");
  const original = { storeDir: join(directory, "pnpm-default"), virtualStoreDir: "node_modules/.pnpm" };
  expect(hook(original)).toBe(original);
  expect(original.virtualStoreDir).toBe("node_modules/.pnpm");
});

test("nested language roots get distinct stores and direct host commands ignore the next check environment", () => {
  const { root, config, load } = fixture();
  writeFileSync(config, "[storage]\nexternal=true\n");
  writeFileSync(join(root, "workbench/local.toml"), '[checks]\nenvironment="guix"\n');
  const nested = join(root, "library");
  mkdirSync(nested);
  mkdirSync(join(nested, "workbench"));
  writeFileSync(join(nested, "workbench/config.toml"), "invalid nested scope config must not replace the repository\n");
  const top = load()({});
  const selected = load(nested)({});
  expect(selected.storeDir).toBe(top.storeDir);
  expect(selected.virtualStoreDir).not.toBe(top.virtualStoreDir);
  expect(selected.virtualStoreDir).toBe(join(buildPaths(root, nested, "native", {}, false).dependencies, "pnpm"));
});

test("managed sessions preserve exported stores across manifest changes", () => {
  const { root, load } = fixture();
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const paths = buildPaths(root, root, "nix-docker", {}, false);
  prepareBuild(paths);
  for (const [key, value] of Object.entries(buildEnvironment(paths))) vi.stubEnv(key, value);
  writeFileSync(join(root, "package.json"), '{"name":"changed-during-session"}\n');
  expect(load()({})).toEqual({
    storeDir: paths.pnpmStore,
    virtualStoreDir: join(paths.dependencies, "pnpm"),
    virtualStoreType: "project",
  });
});

test("standalone examples leave pnpm defaults intact, even with unrelated global preferences", () => {
  const { config, load } = fixture(false);
  writeFileSync(config, "[storage]\nunknown=true\n");
  const original = { nodeLinker: "hoisted", virtualStoreDir: "node_modules/.pnpm" };
  expect(load()(original)).toBe(original);
  expect(original).toEqual({ nodeLinker: "hoisted", virtualStoreDir: "node_modules/.pnpm" });
});

test("broken integration and invalid preferences fail before creating package directories", () => {
  const { root, config, load } = fixture();
  const hook = load();
  writeFileSync(config, "[storage]\nunknown=true\n");
  expect(() => hook({})).toThrow(/Workbench pnpm storage:.*unknown global option/s);
  writeFileSync(config, "[storage]\nexternal=true\n");
  rmSync(join(root, "workbench/config.toml"));
  expect(() => hook({})).toThrow(/Workbench pnpm storage:.*config.toml/s);
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", undefined);
  expect(() => hook({})).toThrow(/could not locate the pinned distribution/);
  rmSync(join(root, "workbench/projects.toml"));
  mkdirSync(join(root, ".workbench"));
  expect(() => hook({})).toThrow(/missing workbench\/projects.toml/);
});

test("external storage rejects incompatible linkers, partial sessions, relative paths, and checkout-local stores", () => {
  const { root, directory, config, load } = fixture();
  const hook = load();
  writeFileSync(config, "[storage]\nexternal=true\n");
  expect(() => hook({ nodeLinker: "hoisted" })).toThrow(/isolated node linker/);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("PNPM_CONFIG_STORE_DIR", join(directory, "store"));
  expect(() => hook({})).toThrow(/virtual store/);
  vi.stubEnv("PNPM_CONFIG_VIRTUAL_STORE_DIR", "relative");
  expect(() => hook({})).toThrow(/absolute/);
  vi.stubEnv("PNPM_CONFIG_VIRTUAL_STORE_DIR", join(root, "node_modules/.pnpm"));
  expect(() => hook({})).toThrow(/outside the project checkout/);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "maybe");
  expect(() => hook({})).toThrow(/invalid inherited Workbench storage selection/);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("PNPM_CONFIG_VIRTUAL_STORE_DIR", join(directory, "virtual-store"));
  vi.stubEnv("WORKBENCH_SHELL_ROOT", directory);
  expect(() => hook({})).toThrow(/another language root/);
  expect(existsSync(join(root, "node_modules"))).toBe(false);
});
