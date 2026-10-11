import { resolveCheckCommand } from "../src/toolchains.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { distributionInputHash, inspectDistribution, sealDistribution } from "../src/distribution-manifest.ts";
import {
  installDistribution,
  installationOwner,
  installedVersion,
  listInstallations,
  pruneInstallations,
  releaseInstallationRoot,
  retainInstallation,
  recoverInstallationStore,
} from "../src/installation-store.ts";
import {
  forgetInstallationGenerations,
  installationRegistration,
  materializeDistribution,
  registerInstallation,
  resolvePinnedDistribution,
  unregisterInstallation,
} from "../src/installation-project.ts";
import { snapshotCIProject } from "../src/ci-workspace.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) {
    const writable = (path) => {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-installation-test-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", "");
  return root;
}
function distribution(root, name, revision = "1".repeat(40), executable = "process.stdout.write('selected-first\\n')") {
  const directory = join(root, name);
  for (const child of ["bin", "bundle", "languages", "workbench", "src"])
    mkdirSync(join(directory, child), { recursive: true });
  writeFileSync(join(directory, "bin/workbench.mjs"), executable);
  writeFileSync(join(directory, "bundle/main.cjs"), "// executable inventory fixture\n");
  writeFileSync(join(directory, "languages/index.toml"), "# language inventory\n");
  writeFileSync(join(directory, "workbench/projects.toml"), "# project registry\n");
  writeFileSync(join(directory, "src/reference.ts"), "export const reference = 1;\n");
  const pin = sealDistribution(directory, revision);
  return { directory, pin };
}
function project(root, name) {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}
function install(root, selected) {
  const store = join(root, "store");
  installDistribution(selected.directory, selected.pin.sha256, store, "user");
  return store;
}
function git(root, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

test("seals bind bytes, executable permissions, paths, and links while allowing whole reference trees to be omitted", () => {
  const root = fixture();
  const { directory, pin } = distribution(root, "candidate");
  expect(inspectDistribution(directory, pin).pin).toEqual(pin);
  const sourceHash = distributionInputHash(directory, "src/reference.ts");
  rmSync(join(directory, "src"), { recursive: true });
  expect(inspectDistribution(directory, pin).pin).toEqual(pin);
  expect(distributionInputHash(directory, "src/reference.ts")).toBe(sourceHash);
  writeFileSync(join(directory, "extra"), "unsealed");
  expect(() => inspectDistribution(directory, pin)).toThrow(/unsealed/);
  rmSync(join(directory, "extra"));
  const manifestPath = join(directory, "workbench-distribution.json");
  const original = readFileSync(manifestPath, "utf8");
  const malformed = JSON.parse(original);
  malformed.files["a/".repeat(65) + "file"] = { sha256: "0".repeat(64), executable: false };
  writeFileSync(manifestPath, JSON.stringify(malformed));
  expect(() => inspectDistribution(directory)).toThrow(/nesting/);
  writeFileSync(manifestPath, original);
  writeFileSync(join(directory, "bin/workbench.mjs"), "different");
  expect(() => inspectDistribution(directory, pin)).toThrow(/differs/);
  expect(() => installDistribution(directory, "0".repeat(64), join(root, "bad-store"), "user")).toThrow();
  expect(existsSync(join(root, "bad-store"))).toBe(false);
});

test("multiple checkouts retain exact versions, rollback generations, and active uses without publishing private paths", () => {
  const root = fixture();
  const one = distribution(root, "one");
  const two = distribution(root, "two", "2".repeat(40));
  const store = install(root, one);
  install(root, two);
  const a = project(root, "project-a");
  const b = project(root, "project-b");
  registerInstallation(a, one.pin, store);
  registerInstallation(b, two.pin, store);
  registerInstallation(a, two.pin, store, true);
  expect(resolvePinnedDistribution(a, repository)).toBe(installedVersion(store, two.pin));
  mkdirSync(join(a, "nested"));
  expect(
    resolveCheckCommand(join(a, "nested"), ["node", "{workbench}/scripts/run.mjs"], installedVersion(store, two.pin)),
  ).toEqual(["node", "../.workbench/scripts/run.mjs"]);
  expect(installationRegistration(a).generations).toEqual([one.pin, two.pin]);
  const use = retainInstallation(store, [one.pin], "use");
  forgetInstallationGenerations(a, [one.pin.sha256]);
  expect(pruneInstallations(store, true).find((entry) => entry.pin.sha256 === one.pin.sha256).reasons).toHaveLength(1);
  expect(existsSync(installedVersion(store, one.pin))).toBe(true);
  const owner = join(store, "owners", installationOwner());
  for (const name of readdirSync(owner)) expect(readFileSync(join(owner, name), "utf8")).not.toContain("project-a");
  releaseInstallationRoot(store, use.id);
  pruneInstallations(store, true);
  expect(existsSync(installedVersion(store, one.pin))).toBe(false);
  expect(existsSync(installedVersion(store, two.pin))).toBe(true);
  expect(() => forgetInstallationGenerations(a, [two.pin.sha256])).toThrow(/current/);
  unregisterInstallation(a);
  unregisterInstallation(b);
  pruneInstallations(store, true);
  expect(readdirSync(join(store, "versions"))).toEqual([]);
  expect(existsSync(join(a, "workbench/distribution.json"))).toBe(true);
});

test("moved checkouts require explicit repair and snapshots carry independent verified dependency bytes", async () => {
  const root = fixture();
  const selected = distribution(root, "candidate");
  const store = install(root, selected);
  const before = project(root, "before");
  registerInstallation(before, selected.pin, store);
  const moved = join(root, "moved");
  const previousProfile = installationRegistration(before).profile;
  renameSync(before, moved);
  expect(() => resolvePinnedDistribution(moved, repository)).toThrow(/location/);
  expect(() => unregisterInstallation(moved)).toThrow(/repair/);
  expect(() => registerInstallation(moved)).toThrow(/location/);
  registerInstallation(moved, undefined, undefined, true);
  expect(installationRegistration(moved).profile).not.toBe(previousProfile);
  expect(listInstallations(store)[0].reasons.some((reason) => reason.id === previousProfile)).toBe(true);
  const snapshot = project(root, "snapshot");
  mkdirSync(join(snapshot, "workbench"));
  cpSync(join(moved, "workbench/distribution.json"), join(snapshot, "workbench/distribution.json"), {
    recursive: true,
  });
  materializeDistribution(moved, snapshot, repository);
  expect(lstatSync(join(snapshot, ".workbench")).isSymbolicLink()).toBe(false);
  expect(inspectDistribution(join(snapshot, ".workbench"), selected.pin).pin).toEqual(selected.pin);
  git(moved, "init", "--quiet");
  git(moved, "add", ".");
  git(moved, "commit", "--quiet", "-m", "fixture");
  const index = git(moved, "write-tree");
  const ci = join(root, "ci");
  await snapshotCIProject(moved, ci);
  expect(inspectDistribution(join(ci, ".workbench"), selected.pin).pin).toEqual(selected.pin);
  expect(git(ci, "ls-files", ".workbench/bin/workbench.mjs")).toBe(".workbench/bin/workbench.mjs");
  expect(git(moved, "write-tree")).toBe(index);
});

test("pruning refuses unknown roots, writer claims, and interrupted fences instead of inferring expiry", () => {
  const root = fixture();
  const selected = distribution(root, "candidate");
  const store = install(root, selected);
  const owner = join(store, "owners", installationOwner());
  mkdirSync(join(owner, "writer.lock"));
  expect(() => pruneInstallations(store, true)).toThrow(/writer/);
  rmSync(join(owner, "writer.lock"), { recursive: true });
  writeFileSync(join(owner, "unknown"), "uncertain");
  expect(() => pruneInstallations(store, true)).toThrow(/unknown/);
  rmSync(join(owner, "unknown"));
  const epoch = JSON.parse(readFileSync(join(store, "epoch.json"), "utf8"));
  writeFileSync(join(store, "epoch.json"), JSON.stringify({ ...epoch, busy: true }));
  expect(() => retainInstallation(store, [selected.pin], "use")).toThrow(/maintenance/);
  expect(() => pruneInstallations(store, true)).toThrow(/recovery/);
  recoverInstallationStore(store);
  expect(listInstallations(store)).toHaveLength(1);
  pruneInstallations(store, true);
  expect(readdirSync(join(store, "versions"))).toEqual([]);
});

test("an ordinary launcher dispatches to the project's exact installed executable and missing pins fail", () => {
  const root = fixture();
  const selected = distribution(root, "candidate");
  const store = install(root, selected);
  const consumer = project(root, "consumer");
  registerInstallation(consumer, selected.pin, store);
  const run = () =>
    spawnSync(process.execPath, [join(repository, "bin/workbench.mjs"), "show-selection"], {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: consumer, WORKBENCH_LOCAL_CONFIG_ROOT: consumer },
    });
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("selected-first\n");
  rmSync(join(consumer, ".workbench"));
  expect(run().stderr).toMatch(/link is missing/);
});

test.skipIf(process.platform === "win32")(
  "sealing rejects link escapes and installation namespaces reject writable or redirected ownership",
  () => {
    const root = fixture();
    const outside = project(root, "outside");
    writeFileSync(join(outside, "secret"), "not a distribution file");
    const candidate = project(root, "bad");
    symlinkSync(outside, join(candidate, "escape"));
    expect(() => sealDistribution(candidate, "1".repeat(40))).toThrow(/escapes/);
    const selected = distribution(root, "candidate");
    const store = install(root, selected);
    chmodSync(join(store, "owners"), 0o777);
    expect(() => listInstallations(store)).toThrow(/ownership/);
  },
);
