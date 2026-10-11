import { spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ciTargets } from "../src/ci-targets.ts";
import { localCIPlan, listLocalCI, rehearsalDocker } from "../src/local-ci.ts";
import { snapshotCIProject } from "../src/ci-workspace.ts";
import { compatibilityRuntimePlan } from "../src/ci-runtime.ts";
import { terminalTable } from "../src/terminal-table.ts";
import { collectReports, reportState } from "../scripts/ci-reports.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-local-ci-test-"));
  temporary.push(root);
  return root;
}
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function initialize(root) {
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "tracked"), "original");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
}

test("target reports exclude stale evidence and retain identical content freshly rewritten by the target", () => {
  const root = fixture();
  const coverage = join(root, "coverage");
  expect(reportState(coverage)).toEqual({});
  mkdirSync(coverage);
  writeFileSync(join(coverage, "coverage-summary.json"), "baseline");
  writeFileSync(join(coverage, "coverage-final.json"), "previous target");
  writeFileSync(join(coverage, "tests.json"), "same result");
  utimesSync(join(coverage, "tests.json"), 1, 1);
  const before = reportState(coverage);
  chmodSync(join(coverage, "coverage-final.json"), 0o600);
  writeFileSync(join(coverage, "tests.json"), "same result");
  mkdirSync(join(coverage, "nested"));
  writeFileSync(join(coverage, "nested/tests.xml"), "current target");
  const destination = join(root, "report");
  collectReports(coverage, destination, before);
  expect(readFileSync(join(destination, "tests.json"), "utf8")).toBe("same result");
  expect(readFileSync(join(destination, "nested/tests.xml"), "utf8")).toBe("current target");
  expect(existsSync(join(destination, "coverage-final.json"))).toBe(false);
  expect(existsSync(join(destination, "coverage-summary.json"))).toBe(false);
  expect(readFileSync(join(coverage, "coverage-final.json"), "utf8")).toBe("previous target");
  const unchanged = join(root, "unchanged");
  collectReports(coverage, unchanged, reportState(coverage));
  expect(existsSync(unchanged)).toBe(false);
  if (process.platform !== "win32") {
    symlinkSync("missing", join(coverage, "broken"));
    expect(() => reportState(coverage)).toThrow(/only real files/);
  }
});

test("local default preserves every configured Linux x64 native, compatibility, and managed target", () => {
  const all = ciTargets(repository);
  const plan = localCIPlan(repository);
  expect(plan.selected.map(({ id }) => id)).toEqual(
    all.filter((target) => target.os === "linux" && target.architecture === "x64").map(({ id }) => id),
  );
  expect(new Set(plan.selected.map(({ kind }) => kind))).toEqual(new Set(["native", "compatibility", "environment"]));
  expect(plan.selected.filter(({ kind }) => kind === "environment").map(({ environment }) => environment)).toEqual(
    expect.arrayContaining(["guix", "nix-docker", "devcontainer"]),
  );
  expect(plan.excluded.every(({ reason }) => reason.includes("no emulation"))).toBe(true);
  expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
  const native = plan.selected.find((target) => target.kind === "native" && target.release);
  const focused = localCIPlan(repository, { target: [native.id], release: false });
  expect(focused.selected).toEqual([
    {
      ...native,
      release: false,
      phases: ["native-install", "native-check"],
      checks: native.checks.filter((check) => !["release", "release-verify"].includes(check.role)),
    },
  ]);
  expect(focused.excluded.some(({ reason }) => reason === "outside selected targets")).toBe(true);
  const python = localCIPlan(repository, { path: "examples/languages/python" });
  expect(python.selected.every(({ path }) => path === "examples/languages/python")).toBe(true);
  expect(python.excluded.some(({ reason }) => reason === "outside selected root")).toBe(true);
  expect(() => localCIPlan(repository, { target: ["missing"] })).toThrow(/configured CI target/);
  expect(() => localCIPlan(repository, { path: "missing" })).toThrow(/configured CI root/);
  expect(() => localCIPlan(repository, { target: [] })).toThrow(/no configured Linux x64 targets/);
  expect(() => localCIPlan(repository, { target: [all.find((target) => target.os === "windows").id] })).toThrow(
    /no configured Linux x64 targets/,
  );
});

test("plan presentation is read only and exposes commands, provenance, exclusions, and platform limits", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  listLocalCI(repository, { path: "examples/languages/python" }, true);
  const json = JSON.parse(log.mock.calls[0][0]);
  expect(
    json.selected
      .find(({ kind }) => kind === "native")
      .checks.some(({ role, source }) => role === "coverage" && source.includes("python/automation.toml")),
  ).toBe(true);
  expect(json.excluded[0].reason).toBeTruthy();
  log.mockClear();
  listLocalCI(repository, { path: "examples/languages/python" });
  const table = log.mock.calls.flat().join("\n");
  expect(table).toContain("TARGET");
  expect(table).toContain("without emulation");
  expect(table).toContain("registry publication");
  expect(terminalTable(["COLUMN"], [["a\nb\u001b"]])).toContain("a b ");
});

test.skipIf(process.platform === "win32")(
  "snapshots preserve staged and unstaged work, deletions, new inputs, summaries, and broken links without touching the index",
  async () => {
    const root = fixture();
    initialize(root);
    writeFileSync(join(root, "deleted"), "delete me");
    git(root, "add", "deleted");
    git(root, "commit", "--quiet", "-m", "delete fixture");
    writeFileSync(join(root, "tracked"), "staged");
    git(root, "add", "tracked");
    writeFileSync(join(root, "tracked"), "pending");
    rmSync(join(root, "deleted"));
    writeFileSync(join(root, "new"), "new input");
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage/coverage-summary.json"), "baseline");
    git(root, "add", "coverage/coverage-summary.json");
    writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage/coverage-final.json\n");
    writeFileSync(join(root, "coverage/coverage-final.json"), "ignored report");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules/large"), "ignored dependency");
    symlinkSync("missing", join(root, "broken"));
    const before = readFileSync(join(root, ".git/index"));
    const destination = join(fixture(), "snapshot");
    await snapshotCIProject(root, destination);
    expect(readFileSync(join(root, ".git/index"))).toEqual(before);
    expect(readFileSync(join(root, "tracked"), "utf8")).toBe("pending");
    expect(git(root, "show", ":tracked")).toBe("staged");
    expect(readFileSync(join(destination, "tracked"), "utf8")).toBe("pending");
    expect(git(destination, "show", ":new")).toBe("new input");
    expect(readFileSync(join(destination, "coverage/coverage-summary.json"), "utf8")).toBe("baseline");
    expect(existsSync(join(destination, "deleted"))).toBe(false);
    expect(existsSync(join(destination, "node_modules"))).toBe(false);
    expect(existsSync(join(destination, "coverage/coverage-final.json"))).toBe(false);
    expect(lstatSync(join(destination, "broken")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, "broken"))).toBe("missing");
  },
);

test("snapshots give an integrated distribution its own independent repository and pending inputs", async () => {
  const root = fixture();
  initialize(root);
  const dependency = join(root, ".workbench");
  mkdirSync(dependency);
  initialize(dependency);
  git(root, "-c", "advice.addEmbeddedRepo=false", "add", ".workbench");
  writeFileSync(join(dependency, "pending"), "draft distribution");
  const destination = join(fixture(), "snapshot");
  const trees = await snapshotCIProject(root, destination);
  expect(trees.map(({ path }) => path)).toEqual([".", ".workbench"]);
  expect(trees[1].tree).toBe(git(join(destination, ".workbench"), "write-tree").trim());
  expect(git(join(destination, ".workbench"), "show", ":pending")).toBe("draft distribution");
  expect(git(dependency, "status", "--porcelain")).toContain("?? pending");
});

test("compatibility acquisition accepts only declared targets and uses recorded verification policy", () => {
  const node = compatibilityRuntimePlan(repository, ".", "node", "22.23.3");
  expect(node.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(node.asset.checksums.signature.keys).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  expect(node.directory).toContain("22.23.3");
  const go = compatibilityRuntimePlan(repository, "examples/languages/go", "go", "1.26.8");
  expect(go.asset.signature).toBeTruthy();
  const rust = ciTargets(repository).find((target) => target.runtime === "rust");
  expect(compatibilityRuntimePlan(repository, rust.path, "rust", rust.version)).toEqual({
    tool: { name: "rust", version: rust.version, source: "configured CI compatibility target" },
  });
  expect(() => compatibilityRuntimePlan(repository, ".", "node", "99.0.0")).toThrow(/not a configured/);
  expect(compatibilityRuntimePlan(repository, "examples/languages/python", "python", "3.11.17").tool).toMatchObject({
    name: "python",
    version: "3.11.17",
  });
});

test.skipIf(process.platform === "win32")(
  "the scoped Docker adapter applies host networking to run and build while preserving other arguments",
  () => {
    const root = fixture();
    const client = join(root, "docker client'fixture");
    writeFileSync(client, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o700 });
    const adapter = join(root, "adapter");
    rehearsalDocker(adapter, client);
    for (const [args, expected] of [
      [
        ["run", "--rm", "image"],
        ["run", "--network=host", "--rm", "image"],
      ],
      [
        ["build", "context"],
        ["build", "--network=host", "context"],
      ],
      [
        ["buildx", "build", "--load", "context"],
        ["buildx", "build", "--network=host", "--load", "context"],
      ],
      [
        ["buildx", "version"],
        ["buildx", "version"],
      ],
      [
        ["inspect", "container"],
        ["inspect", "container"],
      ],
    ]) {
      const child = spawnSync(adapter, args, { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim().split("\n")).toEqual(expected);
    }
    expect(() => rehearsalDocker(adapter, "relative-docker")).toThrow(/absolute Docker client path/);
  },
);
