import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import * as targets from "../src/ci-targets.ts";
import * as core from "../src/core.ts";
import { runLocalCI } from "../src/local-ci.ts";
import { targetPhases } from "../scripts/ci-contract.mjs";
import { CIWorkspace } from "../src/ci-workspace.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-local-execution-"));
  temporary.push(root);
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
  ])
    expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
  writeFileSync(join(root, "draft"), "pending input");
  expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root }).status).toBe(0);
  for (const file of [
    ".node-version",
    "scripts/ci-linux",
    "scripts/ci-run.mjs",
    "scripts/ci-contract.mjs",
    "scripts/ci-worker-request.mjs",
    "scripts/cpu-budget.mjs",
    "scripts/ci-results.mjs",
    "scripts/ci-reports.mjs",
    "scripts/native-assets.json",
    "scripts/keys/node.asc",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    cpSync(join(repository, file), join(root, file), { recursive: true });
  }
  const clients = join(root, "clients");
  mkdirSync(clients);
  cpSync(join(repository, "tests/fixtures/ci-docker.mjs"), join(clients, "docker"));
  mkdirSync(join(root, "bin"));
  cpSync(join(repository, "tests/fixtures/ci-workbench.mjs"), join(root, "bin/workbench.mjs"));
  const eventsFile = join(root, "events");
  writeFileSync(eventsFile, "");
  const reportsFile = join(root, "reports-path");
  vi.stubEnv("FIXTURE_EVENTS", eventsFile);
  vi.stubEnv("FIXTURE_REPORTS", reportsFile);
  vi.stubEnv("PATH", clients + delimiter + process.env.PATH);
  vi.stubEnv("CARGO_HOME", join(root, "private-cargo"));
  vi.stubEnv("RUSTUP_HOME", join(root, "private-rustup"));
  vi.spyOn(core, "distributionRoot").mockReturnValue(root);
  vi.spyOn(core, "readLanguageRoots").mockReturnValue([{ language: "typescript", path: "." }]);
  const slot = join(
    tmpdir(),
    `workbench-ci-${process.getuid()}`,
    createHash("sha256").update(root).digest("hex").slice(0, 24),
  );
  temporary.push(slot);
  const target = (id, kind, environment = "native") => {
    const selection = {
      id,
      kind,
      environment,
      path: ".",
      os: "linux",
      architecture: "x64",
      release: false,
      checks: [],
    };
    return { ...selection, phases: targetPhases(selection) };
  };
  vi.spyOn(targets, "ciTargets").mockReturnValue([
    target("native", "native"),
    target("guix", "environment", "guix"),
    target("devcontainer", "environment", "devcontainer"),
  ]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reports = () => {
    const line = log.mock.calls
      .flat()
      .find((line) => String(line).startsWith("Local CI reports and release artifacts: "));
    const path = line.slice("Local CI reports and release artifacts: ".length);
    temporary.push(resolve(path, ".."));
    return path;
  };
  return {
    root,
    slot,
    reports,
    events: () => readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "real adapters exchange manifests and fresh reports while preserving the checkout and cleaning owned resources",
  async () => {
    const f = fixture();
    const selected = targets.ciTargets(f.root);
    const gcc = {
      ...selected[0],
      id: "gcc",
      kind: "compatibility",
      runtime: "gcc",
      version: "16.2.0",
      roles: ["test", "sanitizers", "lto"],
    };
    vi.mocked(targets.ciTargets).mockReturnValue([...selected, { ...gcc, phases: targetPhases(gcc) }]);
    const before = readFileSync(join(f.root, ".git/index"));
    await runLocalCI(f.root);
    expect(readFileSync(join(f.root, ".git/index"))).toEqual(before);
    expect(readFileSync(join(f.root, "draft"), "utf8")).toBe("pending input");
    expect(existsSync(join(f.slot, "workspace"))).toBe(false);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    const reports = f.reports();
    const run = JSON.parse(readFileSync(join(reports, "results.json"), "utf8"));
    expect(run.errors).toEqual([]);
    expect(run.targets.map(({ success }) => success)).toEqual([true, true, true, true]);
    for (const target of run.targets)
      expect(JSON.parse(readFileSync(join(target.report, "coverage/fixture.json"), "utf8")).target).toBe(target.id);
    expect(f.events()).toContainEqual({ cleaned: "owned-container" });
    expect(f.events().filter(({ target, command }) => target === "gcc" && command === "tools")).toHaveLength(1);
    expect(f.events().filter(({ target, command }) => target === "gcc" && command === "checks")).toHaveLength(3);
    expect(existsSync(resolve(reports, "../image"))).toBe(false);
  },
);

test
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each([
    "build-failure",
    "wrong-architecture",
    "container-failure",
    "no-results",
    "missing-target",
    "incomplete-results",
    "duplicate-target",
    "unknown-target",
    "invalid-error",
    "invalid-results",
    "target-failure",
    "managed-failure",
    "cleanup-failure",
  ])("local %s preserves independent outcomes and records the failure", async (behavior) => {
  const f = fixture();
  vi.stubEnv("FIXTURE_BEHAVIOR", behavior);
  await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI/);
  const run = JSON.parse(readFileSync(join(f.reports(), "results.json"), "utf8"));
  expect(run.targets.map(({ id }) => id)).toEqual(["native", "guix", "devcontainer"]);
  expect(run.targets.find(({ id }) => id === "devcontainer").success).toBe(true);
  if (behavior === "managed-failure") expect(run.targets.find(({ id }) => id === "guix").success).toBe(false);
  else if (behavior === "cleanup-failure") {
    expect(run.targets.every(({ success }) => success)).toBe(true);
    expect(run.errors).toHaveLength(3);
    expect(run.errors.every((error) => error.phase === "cleanup:containers")).toBe(true);
  } else expect(run.targets.find(({ id }) => id === "native").success).toBe(false);
  if (behavior === "target-failure") expect(run.errors).toEqual([]);
  if (behavior === "incomplete-results")
    expect(run.errors).toEqual([expect.objectContaining({ phase: "target execution or results" })]);
  expect(existsSync(join(f.slot, "workspace"))).toBe(behavior === "cleanup-failure");
  expect(existsSync(join(f.slot, "active"))).toBe(behavior === "cleanup-failure");
});

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "job admission creates at most the configured workspace count and releases completed jobs before admitting another",
  async () => {
    const f = fixture();
    mkdirSync(join(f.root, "workbench"));
    writeFileSync(
      join(f.root, "workbench/config.toml"),
      "schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n[execution]\ncpus_per_job = 1\nmax_jobs = 1\n",
    );
    const original = CIWorkspace.prototype.fork;
    const seen = [];
    vi.spyOn(CIWorkspace.prototype, "fork").mockImplementation(async function (id) {
      const directory = await original.call(this, id);
      const jobs = join(f.slot, "jobs");
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(jobs)).toHaveLength(1);
      seen.push(directory);
      return directory;
    });
    await runLocalCI(f.root);
    expect(seen).toHaveLength(3);
    expect(seen.every((path) => !existsSync(path))).toBe(true);
    const reports = f.reports();
    const run = JSON.parse(readFileSync(join(reports, "results.json"), "utf8"));
    expect(
      run.targets.every((target) => target.success && existsSync(join(target.report, "coverage/fixture.json"))),
    ).toBe(true);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "interruption during preparation cleans the partial run without admitting jobs and restores signal handlers",
  async () => {
    const f = fixture();
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const snapshot = CIWorkspace.prototype.snapshot;
    vi.spyOn(CIWorkspace.prototype, "snapshot").mockImplementation(async function (lifecycle) {
      expect(process.listenerCount("SIGINT")).toBe(counts[0] + 1);
      const trees = await snapshot.call(this, lifecycle);
      lifecycle.interrupted = true;
      return trees;
    });
    await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI failed/);
    const run = JSON.parse(readFileSync(join(f.reports(), "results.json"), "utf8"));
    expect(run.targets.every((target) => target.started === undefined)).toBe(true);
    expect(run.errors).toEqual([{ phase: "interruption", message: expect.stringContaining("active mutations") }]);
    expect(existsSync(join(f.slot, "workspace"))).toBe(false);
    expect(existsSync(join(f.slot, "jobs"))).toBe(false);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "active and abandoned workspaces are preserved",
  async () => {
    const f = fixture();
    mkdirSync(join(f.slot, "active"), { recursive: true, mode: 0o700 });
    await expect(runLocalCI(f.root)).rejects.toThrow(/busy or needs recovery/);
    expect(existsSync(join(f.slot, "active"))).toBe(true);
    rmSync(join(f.slot, "active"), { recursive: true });
    mkdirSync(join(f.slot, "workspace"));
    writeFileSync(join(f.slot, "workspace/user-data"), "preserve");
    await expect(runLocalCI(f.root)).rejects.toThrow(/Preserving an existing/);
    expect(readFileSync(join(f.slot, "workspace/user-data"), "utf8")).toBe("preserve");
    expect(existsSync(join(f.slot, "active"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "the shutdown scope remains active through final cleanup and records an interruption without losing completed outcomes",
  async () => {
    const f = fixture();
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let lifecycle;
    const snapshot = CIWorkspace.prototype.snapshot;
    const close = CIWorkspace.prototype.close;
    vi.spyOn(CIWorkspace.prototype, "snapshot").mockImplementation(async function (scope) {
      lifecycle = scope;
      return snapshot.call(this, scope);
    });
    vi.spyOn(CIWorkspace.prototype, "close").mockImplementation(async function () {
      expect(process.listenerCount("SIGTERM")).toBe(counts[1] + 1);
      lifecycle.interrupted = true;
      return close.call(this);
    });
    await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI failed/);
    const run = JSON.parse(readFileSync(join(f.reports(), "results.json"), "utf8"));
    expect(run.targets.every((target) => target.success)).toBe(true);
    expect(run.errors).toEqual([{ phase: "interruption", message: expect.stringContaining("active mutations") }]);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  },
);
