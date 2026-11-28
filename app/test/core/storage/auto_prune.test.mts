import { cacheAmount } from "../../../src/core/storage/cache-size.ts";
import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerProject,
  updateProjectRequirements,
  keepCacheAsset,
} from "../../../src/core/projects/project-registry.ts";
import { autoPrune, pruneAfterGate } from "../../../src/core/storage/auto-prune.ts";
import {
  managerInstallations,
  recordManagerInstallations,
  ownsManagerInstallation,
} from "../../../src/core/execution/environments/managed-installations.ts";
const fake = vi.hoisted(() => ({
  report: {
    entries: [] as {
      provider: string;
      tool: string;
      version: string;
      directory: string;
      protected: string[];
      identity: string;
    }[],
    issues: [] as string[],
  },
  observe: undefined as (() => void) | undefined,
  removed: [] as string[],
  measuredBytes: null as number | null | undefined,
}));
vi.mock("../../../src/core/toolchains/tool-cache.ts", () => ({
  toolInstallationGroups: () => [],
  inspectToolCache: () => {
    fake.observe?.();
    const first = fake.report.entries[0];
    if (first) fake.measuredBytes = cacheAmount(first.directory).bytes;
    return fake.report;
  },
  prunableTools: () => fake.report.entries.filter((entry) => !entry.protected.length),
  pruneToolCache: (report: typeof fake.report) => {
    fake.removed.push(...report.entries.map((entry) => entry.version));
    return Promise.resolve([]);
  },
}));
vi.mock("../../../src/core/projects/project-requirements.ts", () => ({
  projectRequirements: () => [],
  projectRequirementSnapshot: () => [],
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  fake.report.entries = [];
  fake.observe = undefined;
  fake.removed = [];
  fake.measuredBytes = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-autoprune-")));
  roots.push(base);
  for (const kind of ["STATE", "CACHE", "CONFIG"]) vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(base, kind));
  const root = join(base, "project");
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  registerProject(root, "demo");
  const entry = (version: string, protectedBy: string[] = []) => ({
    provider: "workbench",
    tool: "node",
    version,
    directory: join(base, version),
    protected: protectedBy,
    identity: version,
  });
  fake.report.entries = [
    entry("26.12.1"),
    entry("26.12.2", ["registered project"]),
    entry("25.12.1"),
    entry("26.11.9"),
  ];
  updateProjectRequirements(root, [], "", [
    { tool: "node", version: "26.12.2", directory: join(base, "26.12.2"), root: ".", profile: "" },
  ]);
  return { base, root };
}
test("automatic pruning retires only superseded patches with working replacement evidence", async () => {
  const { root } = fixture();
  await autoPrune(root);
  expect(fake.removed).toEqual(["26.12.1"]);
});
test("automatic pruning stops before deleting a candidate when canceled during inspection", async () => {
  const { root } = fixture();
  const stop = new AbortController();
  fake.observe = () => {
    stop.abort();
  };
  await expect(pruneAfterGate(root, stop.signal)).rejects.toThrow(/aborted/i);
  expect(fake.removed).toEqual([]);
});
test("disabled pruning, protected installations, and unsuccessful replacement evidence preserve old tools", async () => {
  const { base, root } = fixture();
  const bytecode = join(base, "CACHE/node-compile/old-node/bytecode");
  mkdirSync(join(base, "CACHE/node-compile/old-node"), { recursive: true });
  writeFileSync(bytecode, "old bytecode");
  utimesSync(bytecode, new Date(0), new Date(0));
  mkdirSync(join(base, "CONFIG"), { recursive: true });
  writeFileSync(join(base, "CONFIG/config.toml"), "[cache]\nauto_prune=false\n");
  await autoPrune(root);
  expect(fake.removed).toEqual([]);
  expect(existsSync(bytecode)).toBe(true);
  writeFileSync(join(base, "CONFIG/config.toml"), "[cache]\nauto_prune=true\n");
  fake.report.entries[0]?.protected.push("active command");
  await autoPrune(root);
  expect(fake.removed).toEqual([]);
  expect(existsSync(bytecode)).toBe(false);
  updateProjectRequirements(root, [], "", []);
  fake.report.entries[0]?.protected.splice(0);
  await autoPrune(root);
  expect(fake.removed).toEqual([]);
});
test("manager ownership is granted only for newly installed directories and lost when identity changes", () => {
  const { base } = fixture();
  const home = join(base, "rustup");
  const existing = join(home, "toolchains/1.99.0-test");
  mkdirSync(existing, { recursive: true });
  const env = { ...process.env, RUSTUP_HOME: home };
  const previous = managerInstallations("rustup", env);
  const added = join(home, "toolchains/1.99.1-test");
  mkdirSync(added);
  recordManagerInstallations("rustup", previous, env, ["1.99.1"]);
  expect(ownsManagerInstallation({ provider: "rustup", directory: existing })).toBe(false);
  expect(ownsManagerInstallation({ provider: "rustup", directory: added })).toBe(true);
  const retained = join(home, "retained");
  mkdirSync(retained);
  keepCacheAsset(retained, true);
  rmSync(added, { recursive: true });
  mkdirSync(added);
  expect(ownsManagerInstallation({ provider: "rustup", directory: added })).toBe(false);
  expect(existsSync(existing)).toBe(true);
});

test("automatic cleanup uses metadata without recursively measuring installed payloads", async () => {
  const { base, root } = fixture();
  mkdirSync(join(base, "26.12.1"));
  writeFileSync(join(base, "26.12.1/payload"), "installed bytes");
  await autoPrune(root);
  expect(fake.removed).toEqual(["26.12.1"]);
  expect(fake.measuredBytes).toBeUndefined();
});
