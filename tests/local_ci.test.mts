import { required } from "../src/invariants.ts";
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
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ciTargets } from "../src/ci-targets.ts";
import { localCIPlan, listLocalCI, rehearsalDocker } from "../src/local-ci.ts";
import { snapshotCIProject } from "../src/ci-workspace.ts";
import { nativeTools } from "../src/native-assets.ts";
import { synchronize } from "../src/sync.ts";
import * as assets from "../src/native-assets.ts";
import { collectReports, reportState } from "../scripts/ci-reports.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", repository);
  const root = mkdtempSync(join(tmpdir(), "workbench-local-ci-test-"));
  temporary.push(root);
  return root;
}
function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function initialize(root: string) {
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
  expect(new Set(plan.selected.map(({ kind }) => kind))).toEqual(new Set(["native", "environment"]));
  expect(plan.selected.filter(({ kind }) => kind === "environment").map(({ environment }) => environment)).toEqual(
    expect.arrayContaining(["guix", "nix"]),
  );
  expect(plan.excluded.every(({ reason }) => reason.includes("no emulation"))).toBe(true);
  expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
  const native = plan.selected.find((target) => target.kind === "native" && target.release);
  const focused = localCIPlan(repository, {
    target: [required(native, "Expected fixture value: native").id],
    release: false,
  });
  expect(focused.selected).toEqual([
    {
      ...native,
      release: false,
      phases: ["native-install", "native-check"],
      checks: required(native, "Expected fixture value: native").checks.filter(
        (check) => !["release", "release-verify"].includes(check.role),
      ),
    },
  ]);
  expect(focused.excluded.some(({ reason }) => reason === "outside selected targets")).toBe(true);
  const python = localCIPlan(repository, { path: "examples/languages/python" });
  expect(python.selected.every(({ path }) => path === "examples/languages/python")).toBe(true);
  expect(python.excluded.some(({ reason }) => reason === "outside selected root")).toBe(true);
  expect(() => localCIPlan(repository, { target: ["missing"] })).toThrow(/configured CI target/);
  expect(() => localCIPlan(repository, { path: "missing" })).toThrow(/configured CI root/);
  expect(() => localCIPlan(repository, { target: [] })).toThrow(/no configured Linux x64 targets/);
  expect(() =>
    localCIPlan(repository, {
      target: [
        required(
          all.find((target) => target.os === "windows"),
          'Expected fixture value: all.find((target) => target.os === "windows")',
        ).id,
      ],
    }),
  ).toThrow(/no configured Linux x64 targets/);
});

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "the public CI command executes the advertised allocation without a single-job wrapper",
  () => {
    const root = fixture();
    initialize(root);
    mkdirSync(join(root, "workbench"));
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "clients"));
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version=1\n[compatibility]\nrequired=false\n[markdown]\nwrap_width=120\n[citations]\nlibrary_dir="library/citations"\n[ci]\noperating_systems=["linux"]\nenvironments=[]\n' +
        [".", "app"]
          .map(
            (path) =>
              `[[check]]\nname="Fixture ${path} test"\npath="${path}"\nrole="test"\ncommand=["node","-e","process.exit(0)"]\n`,
          )
          .join(""),
    );
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="fixture"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\nci_compatibility=false\n[[language_root]]\nlanguage="typescript"\npath="app"\nci_compatibility=false\n',
    );
    for (const directory of [root, join(root, "app")]) {
      writeFileSync(join(directory, ".node-version"), process.versions.node);
      writeFileSync(join(directory, "package.json"), JSON.stringify({ engines: { node: ">=22.0.0" } }));
    }
    writeFileSync(
      join(root, "workbench/CHARTER.md"),
      readFileSync(join(repository, "tests/fixtures/records/CHARTER.md")),
    );
    synchronize(root);
    writeFileSync(join(root, "clients/docker"), '#!/bin/sh\necho "fixture Docker unavailable" >&2\nexit 2\n', {
      mode: 0o700,
    });
    const env = {
      ...process.env,
      PATH: join(root, "clients") + delimiter + (process.env.PATH ?? ""),
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_DISTRIBUTION_ROOT: repository,
      WORKBENCH_CONFIG_HOME: join(root, "preferences"),
      WORKBENCH_DATA_HOME: join(root, "data"),
      WORKBENCH_CPUS: undefined,
      WORKBENCH_MAX_JOBS: "8",
    };
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [join(repository, "bundle/main.cjs"), "ci", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    const advertised = invoke("--json");
    expect(advertised.status, advertised.stdout + advertised.stderr).toBe(0);
    const planned = JSON.parse(advertised.stdout) as ReturnType<typeof localCIPlan>;
    const executed = invoke();
    expect(executed.status).not.toBe(0);
    const reports = /Local CI reports and release artifacts: (.+)/.exec(executed.stdout)?.[1];
    expect(reports).toBeTruthy();
    temporary.push(resolve(required(reports, "Expected fixture value"), ".."));
    expect(executed.stdout + executed.stderr).toContain("fixture Docker unavailable");
    const actual = JSON.parse(
      readFileSync(join(required(reports, "Expected fixture value"), "plan.json"), "utf8"),
    ) as ReturnType<typeof localCIPlan>;
    expect(actual.selected).toEqual(planned.selected);
    expect(actual.resources).toEqual(planned.resources);
  },
);

test("plan presentation is read only and exposes commands, provenance, exclusions, and platform limits", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  listLocalCI(repository, { path: "examples/languages/python" }, true);
  const json = JSON.parse(
    String(required(log.mock.calls[0], "Expected fixture value: log.mock.calls[0]")[0]),
  ) as ReturnType<typeof localCIPlan>;
  expect(
    required(
      json.selected.find(({ kind }) => kind === "native"),
      "Expected fixture value",
    ).checks.some(
      ({ role, source }) =>
        role === "coverage" && required(source, "Expected fixture value").includes(join("python", "automation.toml")),
    ),
  ).toBe(true);
  expect(required(json.excluded[0], "Expected fixture value").reason).toBeTruthy();
  log.mockClear();
  listLocalCI(repository, { path: "examples/languages/python" });
  const table = log.mock.calls.flat().join("\n");
  expect(table).toContain("TARGET");
  expect(table).toContain("without emulation");
  expect(table).toContain("registry publication");
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

test("snapshots preserve ordinary nested repositories and supply the independently installed runtime", async () => {
  const root = fixture();
  initialize(root);
  const dependency = join(root, "module");
  mkdirSync(dependency);
  initialize(dependency);
  git(root, "-c", "advice.addEmbeddedRepo=false", "add", "module");
  writeFileSync(join(dependency, "pending"), "draft module");
  const destination = join(fixture(), "snapshot");
  const trees = await snapshotCIProject(root, destination);
  expect(trees.map(({ path }) => path)).toEqual([".", "module"]);
  expect(required(trees[1], "Expected fixture value: trees[1]").tree).toBe(
    git(join(destination, "module"), "write-tree").trim(),
  );
  expect(git(join(destination, "module"), "show", ":pending")).toBe("draft module");
  expect(git(dependency, "status", "--porcelain")).toContain("?? pending");
  expect(existsSync(join(destination, ".git/workbench/runtime/bin/workbench.mjs"))).toBe(true);
  expect(git(destination, "ls-files", ".git/workbench/runtime").trim()).toBe("");
});

test("named profiles resolve their selected authenticated artifact without changing the development pin", () => {
  const node = nativeTools(repository, repository, { toolchain: "node-22" }).find((tool) => tool.name === "node");
  const asset = assets.assetFor(repository, required(node, "Expected fixture value"), repository, "linux-x64");
  expect(required(asset, "Expected fixture value: asset").sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    required(required(asset, "Expected fixture value: asset").checksums, "Expected fixture value: asset.checksums")
      .signature.keys,
  ).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  expect(required(node, "Expected fixture value: node").version).toBe("22.23.4");
  expect(
    required(
      nativeTools(repository, repository).find((tool) => tool.name === "node"),
      'Expected fixture value: nativeTools(repository, repository).find((tool) => tool.name === "node")',
    ).version,
  ).toBe("26.12.1");
  expect(() => nativeTools(repository, repository, { toolchain: "missing" })).toThrow(/unknown tool profile/);
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
    ] as const) {
      const child = spawnSync(adapter, args, { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim().split("\n")).toEqual(expected);
    }
    expect(() => {
      rehearsalDocker(adapter, "relative-docker");
    }).toThrow(/absolute Docker client path/);
  },
);
