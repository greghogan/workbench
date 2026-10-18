import { imageEntry } from "./fixtures/cache.mjs";
import { terminal } from "./fixtures/terminal.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { Command } from "commander";
import * as fs from "node:fs";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  chooseCachePrune,
  groupCacheEntries,
  inspectBuildCache,
  printCacheReport,
  pruneBuildCache,
  cachePruneCandidates,
  pruneCache,
  registerCacheCommands,
} from "../src/build-cache.ts";
import {
  buildPaths,
  cleanBuilds,
  prepareBuild,
  withBuildLock,
  buildLockDirectory,
  checkLogDirectory,
  prepareCheckLogs,
} from "../src/builds.ts";
import { withCacheLockSync } from "../src/cache-lock.ts";

const distribution = resolve(import.meta.dirname, "..");
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readdirSync: vi.fn(actual.readdirSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const removeDirectory = required(vi.mocked(rm).getMockImplementation(), "Filesystem mock implementation");
const temporary: string[] = [];
afterEach(() => {
  vi.mocked(rm).mockImplementation(removeDirectory);
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-cache-")));
  temporary.push(base);
  const cache = join(base, "cache"),
    config = join(base, "config");
  mkdirSync(config);
  writeFileSync(join(config, "config.toml"), "[storage]\nexternal=true\n");
  for (const [name, value] of Object.entries({
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_CONFIG_HOME: config,
    WORKBENCH_STORAGE_EXTERNAL: undefined,
    WORKBENCH_STORAGE_ROOT: undefined,
    WORKBENCH_CONTAINER_CHECKOUT: undefined,
    WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
    WORKBENCH_PROJECT_ROOT: undefined,
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
  }))
    vi.stubEnv(name, value);
  const projects = ["first/widget", "second/widget"].map((name) => {
    const root = join(base, name);
    mkdirSync(join(root, "workbench"), { recursive: true });
    mkdirSync(join(root, "library"));
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="widget"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
    );
    const paths = buildPaths(root, root, "native", {}, false);
    return { root, paths };
  });
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd,
      env: process.env,
      encoding: "utf8",
    });
  const json = (cwd: string, ...args: string[]) => {
    const result = run(cwd, ...args, "--json");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ReturnType<typeof inspectBuildCache> & {
      applied?: boolean;
      removed?: string[];
    };
  };
  const populate = () => {
    for (const { paths } of projects) {
      prepareBuild(paths);
      writeFileSync(join(paths.directory, "output"), "build output");
      writeFileSync(join(paths.dependencies, "dependency"), "installed dependency");
    }
  };
  return { base, cache, projects, populate, run, json };
}

test("owned check logs include earlier runs, group with their checkout, and prune while preserving active work", async () => {
  const { cache, projects, populate } = fixture();
  const root = required(projects[0], "Expected fixture value: projects[0]").root;
  populate();
  const older = checkLogDirectory(cache, root, ".", "older");
  mkdirSync(older, { recursive: true });
  writeFileSync(join(older, "step.log"), "earlier diagnostic");
  const newer = prepareCheckLogs(cache, root, ".", "newer");
  writeFileSync(join(newer, "group.log"), "current diagnostic");
  const unknown = checkLogDirectory(
    cache,
    required(projects[1], "Expected fixture value: projects[1]").root,
    ".",
    "unattributed",
  );
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, "log"), "preserve unknown ownership");
  const report = inspectBuildCache(root);
  expect(
    report.entries
      .filter(({ kind }) => kind === "logs")
      .map(({ directory }) => directory)
      .sort(),
  ).toEqual([older, newer].sort());
  const group = groupCacheEntries(report.entries)[0];
  expect(required(group, "Expected fixture value: group").checks).toBeGreaterThan(0);
  expect(required(group, "Expected fixture value: group").checkout).toBe(root);
  expect(inspectBuildCache().entries.some(({ directory }) => directory === unknown)).toBe(false);
  await withCacheLockSync(newer, async () => {
    await expect(pruneBuildCache(report, false, true)).rejects.toThrow(/busy|recovery/);
    expect(report.entries.every(({ directory }) => existsSync(directory))).toBe(true);
  });
  await pruneBuildCache(report, false, true);
  expect(existsSync(older)).toBe(false);
  expect(existsSync(newer)).toBe(false);
  expect(existsSync(required(projects[0], "Expected fixture value: projects[0]").paths.directory)).toBe(false);
  expect(existsSync(required(projects[0], "Expected fixture value: projects[0]").paths.dependencies)).toBe(true);
  expect(existsSync(unknown)).toBe(true);
});

test("prune offers omit already locked projects and explain retention before confirmation", () => {
  const { projects, populate } = fixture();
  populate();
  withBuildLock(required(projects[0], "Expected fixture value: projects[0]").paths, () => {
    const candidates = cachePruneCandidates(inspectBuildCache(), true);
    expect(
      candidates.entries.every(
        (entry) => entry.identity.checkout === required(projects[1], "Expected fixture value: projects[1]").root,
      ),
    ).toBe(true);
    expect(required(candidates.retained, "Expected fixture value: candidates.retained").join(" ")).toContain(
      required(projects[0], "Expected fixture value: projects[0]").root,
    );
    expect(required(candidates.retained, "Expected fixture value: candidates.retained").join(" ")).toContain(
      "retained",
    );
    expect(existsSync(required(projects[0], "Expected fixture value: projects[0]").paths.directory)).toBe(true);
  });
});

test("the project channel pin invalidates every Guix subproject independently of native inputs", () => {
  const { projects } = fixture();
  const { root } = required(projects[0], "Fixture value projects[0]");
  const child = join(root, "library");
  writeFileSync(join(root, "channels.scm"), "first root pin");
  const before = buildPaths(root, child, "guix", {}, false);
  const native = buildPaths(root, child, "native", {}, false);
  writeFileSync(join(root, "channels.scm"), "second root pin");
  expect(buildPaths(root, child, "guix", {}, false).dependencies).not.toBe(before.dependencies);
  writeFileSync(join(child, "channels.scm"), "independent nested pin");
  const independent = buildPaths(root, child, "guix", {}, false);
  expect(independent.dependencies).not.toBe(before.dependencies);
  writeFileSync(join(root, "channels.scm"), "third root pin");
  expect(buildPaths(root, child, "guix", {}, false).dependencies).toBe(independent.dependencies);
  expect(buildPaths(root, child, "native", {}, false).dependencies).toBe(native.dependencies);
});

test("inspection is read-only, and identifies same-named checkouts and their roots without relying on checkout existence", () => {
  const { base, cache, projects, populate } = fixture();
  const [first, second] = projects;
  expect(inspectBuildCache().entries).toEqual([]);
  expect(existsSync(cache)).toBe(false);
  populate();
  const library = buildPaths(
    required(first, "Expected fixture value: first").root,
    join(required(first, "Expected fixture value: first").root, "library"),
    "guix",
    {},
    false,
  );
  prepareBuild(library);
  const selected = inspectBuildCache(required(first, "Expected fixture value: first").root);
  expect(new Set(selected.entries.map((entry) => entry.identity.checkout))).toEqual(
    new Set([required(first, "Expected fixture value: first").root]),
  );
  expect(new Set(selected.entries.map((entry) => entry.identity.root))).toEqual(new Set([".", "library"]));
  expect(selected.entries.every((entry) => entry.bytes > 0)).toBe(true);
  const alias = join(base, "checkout alias");
  symlinkSync(required(first, "Expected fixture value: first").root, alias, "junction");
  expect(inspectBuildCache(alias)).toEqual(selected);
  const all = inspectBuildCache(required(first, "Expected fixture value: first").root, true);
  expect(all.checkout).toBeNull();
  expect(new Set(all.entries.map((entry) => entry.identity.checkout))).toEqual(
    new Set(projects.map((entry) => entry.root)),
  );
  expect(basename(required(first, "Expected fixture value: first").root)).toBe(
    basename(required(second, "Expected fixture value: second").root),
  );
  rmSync(required(second, "Expected fixture value: second").root, { recursive: true });
  expect(
    inspectBuildCache().entries.some(
      (entry) => entry.identity.checkout === required(second, "Expected fixture value: second").root,
    ),
  ).toBe(true);
});

test("nested native root paths remain valid in ownership receipts and both cleanup entry points", async () => {
  const { projects, populate } = fixture();
  populate();
  const first = projects[0],
    nested = join(required(first, "Expected fixture value: first").root, "library/component");
  mkdirSync(nested, { recursive: true });
  const paths = buildPaths(required(first, "Expected fixture value: first").root, nested, "native", {}, false);
  prepareBuild(paths);
  const report = inspectBuildCache(required(first, "Expected fixture value: first").root);
  expect(report.entries.find((entry) => entry.directory === paths.directory)?.identity.root).toBe(
    join("library", "component"),
  );
  cleanBuilds(paths, true);
  expect(existsSync(paths.directory)).toBe(false);
  prepareBuild(paths);
  await pruneBuildCache(inspectBuildCache(required(first, "Expected fixture value: first").root), true, true);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(nested)).toBe(true);
});

test("container and local-CI checkout identities agree across builds, cache selection, and pruning", async () => {
  const { base, projects } = fixture();
  const first = projects[0],
    host = join(base, "host-checkout#container");
  vi.stubEnv("WORKBENCH_CONTAINER_CHECKOUT", host);
  const paths = buildPaths(
    required(first, "Expected fixture value: first").root,
    required(first, "Expected fixture value: first").root,
    "native",
    {},
    false,
  );
  prepareBuild(paths);
  const report = inspectBuildCache(required(first, "Expected fixture value: first").root);
  expect(report.checkout).toBe(host);
  expect(report.entries).toHaveLength(2);
  expect(report.entries.every((entry) => entry.identity.checkout === host)).toBe(true);
  expect(
    inspectBuildCache(
      required(first, "Expected fixture value: first").root,
      false,
      required(first, "Expected fixture value: first").root,
    ),
  ).toEqual(report);
  expect(inspectBuildCache(required(first, "Expected fixture value: first").root, false, host)).toEqual(report);
  expect(inspectBuildCache(undefined).entries).toEqual(report.entries);
  await pruneBuildCache(report, true, true);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(paths.dependencies)).toBe(false);
});

test("local CI targets share their checkout group but isolate products, locks, and scoped cleanup", async () => {
  const { projects, populate } = fixture();
  populate();
  const { root, paths: ordinary } = required(projects[0], "Fixture value projects[0]");
  vi.stubEnv("WORKBENCH_LOCAL_CI_IMAGE", "ubuntu@sha256:first");
  vi.stubEnv("WORKBENCH_CI_TARGET", "native-linux");
  const first = buildPaths(root, root, "native", {}, false);
  vi.stubEnv("WORKBENCH_CI_TARGET", "compatibility-node");
  const second = buildPaths(root, root, "native", {}, false);
  vi.stubEnv("WORKBENCH_LOCAL_CI_IMAGE", "ubuntu@sha256:second");
  const third = buildPaths(root, root, "native", {}, false);
  for (const paths of [first, second, third]) prepareBuild(paths);
  expect(new Set([ordinary, first, second, third].map((paths) => paths.directory)).size).toBe(4);
  const report = inspectBuildCache(root);
  expect(report.entries).toHaveLength(8);
  expect(new Set(report.entries.map((entry) => entry.identity.checkout))).toEqual(new Set([root]));
  expect(first.identity.localCI).toEqual({ image: "ubuntu@sha256:first", target: "native-linux" });
  await withBuildLock(first, async () => {
    expect(() => {
      withBuildLock(second, () => undefined);
    }).not.toThrow();
    expect(() => {
      withBuildLock(first, () => undefined);
    }).toThrow(/another build/);
    await expect(pruneBuildCache(report, true, true)).rejects.toThrow(/another build/);
    // Receipt property order must not change which active build lock pruning acquires.
    const receipt = join(first.directory, ".workbench-build.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        ...first.identity,
        localCI: {
          target: required(first.identity.localCI, "Expected fixture value: first.identity.localCI").target,
          image: required(first.identity.localCI, "Expected fixture value: first.identity.localCI").image,
        },
      }),
    );
    await expect(pruneBuildCache(inspectBuildCache(root), true, true)).rejects.toThrow(/another build/);
  });
  expect(report.entries.every((entry) => existsSync(entry.directory))).toBe(true);
  cleanBuilds(first, true);
  expect(existsSync(first.directory)).toBe(false);
  expect([ordinary, second, third].every((paths) => existsSync(paths.directory))).toBe(true);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    printCacheReport(inspectBuildCache(root));
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("LOCAL CI TARGET");
    expect(text).toContain("compatibility-node");
    expect(text).toContain("Estimated size:");
    expect(text).not.toContain("#local-ci:");
    expect(text).not.toContain("apparent file");
    expect(text).not.toContain("Shared downloads");
  } finally {
    log.mockRestore();
  }
  await pruneBuildCache(inspectBuildCache(root), true, true);
  expect([ordinary, second, third].some((paths) => existsSync(paths.directory))).toBe(false);
});

test("incomplete local CI environment or receipt metadata is rejected", () => {
  const { projects } = fixture();
  const { root, paths } = required(projects[0], "Fixture value projects[0]");
  vi.stubEnv("WORKBENCH_LOCAL_CI_IMAGE", "ubuntu@sha256:first");
  vi.stubEnv("WORKBENCH_CI_TARGET", undefined);
  expect(() => buildPaths(root, root, "native", {}, false)).toThrow(/requires an image and target/);
  prepareBuild(paths);
  for (const localCI of [
    null,
    [],
    {},
    { image: "", target: "native" },
    { image: "first", target: null },
    { image: 42, target: "native" },
    { image: "first", target: 12 },
  ]) {
    writeFileSync(join(paths.directory, ".workbench-build.json"), JSON.stringify({ ...paths.identity, localCI }));
    expect(() => inspectBuildCache(root)).toThrow(/invalid local CI ownership/);
    expect(existsSync(paths.directory)).toBe(true);
  }
});

test("reports use decimal quantities, aligned number/unit columns, project subtotals, and group separators", () => {
  const entries = (
    [
      ["/before", ".", "builds", 10],
      ["/first", ".", "builds", 1000],
      ["/first", ".", "dependencies", 999],
      ["/first", "nested", "builds", 2_000_000],
      ["/second", ".", "builds", 1_000_000_000],
      ["/second", ".", "dependencies", 1],
    ] as const
  ).map(([checkout, root, kind, bytes]) => ({
    directory: "unused",
    kind,
    bytes,
    identity: { checkout, root, environment: "native" as const, fingerprint: "a".repeat(24) },
  }));
  expect(groupCacheEntries(entries)).toMatchObject([
    { checkout: "/before", count: 1, builds: 10, dependencies: 0, rows: [{ root: ".", target: "—" }] },
    { checkout: "/first", count: 3, builds: 2_001_000, dependencies: 999, rows: [{ root: "." }, { root: "nested" }] },
    { checkout: "/second", count: 2, builds: 1_000_000_000, dependencies: 1, rows: [{ root: "." }] },
  ]);
  expect(groupCacheEntries([...entries].reverse())).toEqual(groupCacheEntries(entries));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    printCacheReport({ storageRoot: "/cache", checkout: null, entries });
    const table = log.mock.calls.map(([value]) => String(value)).find((value) => value.startsWith("+"));
    const lines = required(table, "Cache report table").split("\n");
    const totals = lines.filter((line: string | string[]) => line.includes("Project total"));
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatch(/2\.0 MB/);
    for (const checkout of ["/before", "/second"]) {
      const index = lines.findIndex((line: string | string[]) => line.includes(`| ${checkout} `));
      expect(index).toBeGreaterThan(0);
      expect(lines[index + 1]).toBe(lines[0]);
    }
    const checkoutEnd = required(lines[1], "Table header").indexOf("|", 1);
    for (const line of totals) {
      const index = lines.indexOf(line);
      expect(lines[index - 1]).toBe(
        `|${" ".repeat(checkoutEnd - 1)}${required(lines[0], "Table border").slice(checkoutEnd)}`,
      );
      expect(lines[index + 1]).toBe(lines[0]);
    }
    expect(lines.filter((line: string) => line.startsWith("| ") && line.includes("+-"))).toHaveLength(1);
    const rows = lines.filter(
      (line: string) => line.startsWith("|") && !line.includes("CHECKOUT") && !line.includes("+-"),
    );
    expect(rows).toHaveLength(5);
    expect(table).toContain("1.0 kB");
    expect(table).toContain("1.0 GB");
    expect(table).not.toMatch(/KiB|MiB|GiB/);
  } finally {
    log.mockRestore();
  }
});

test.each(["file", "directory"])("cache sizing silently skips a disappearing %s", async (kind) => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { projects, populate } = fixture();
  populate();
  const directory = required(projects[0], "Expected fixture value: projects[0]").paths.directory;
  const disappearing = join(directory, "temporary");
  if (kind === "directory") mkdirSync(disappearing);
  writeFileSync(kind === "directory" ? join(disappearing, "output") : disappearing, "x".repeat(1000));
  const before = required(
    inspectBuildCache().entries.find((entry) => entry.directory === directory),
    "Expected fixture value: inspectBuildCache().entries.find((entry) => entry.directory === directory)",
  ).bytes;
  if (kind === "directory")
    vi.mocked(fs.readdirSync).mockImplementation((path, options) => {
      if (path === disappearing) rmSync(disappearing, { recursive: true, force: true });
      return actual.readdirSync(path, options);
    });
  else
    vi.mocked(fs.lstatSync).mockImplementation((path, options) => {
      if (path === disappearing) rmSync(disappearing, { recursive: true, force: true });
      return actual.lstatSync(path, options);
    });
  try {
    const report = inspectBuildCache();
    expect(
      required(
        report.entries.find((entry) => entry.directory === directory),
        "Expected fixture value: report.entries.find((entry) => entry.directory === directory)",
      ).bytes,
    ).toBe(before - 1000);
  } finally {
    vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  }
});

test("cache sizing still reports filesystem errors other than disappearing files", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { projects, populate } = fixture();
  populate();
  const blocked = join(required(projects[0], "Expected fixture value: projects[0]").paths.directory, "output");
  vi.mocked(fs.lstatSync).mockImplementation((path, ...args) => {
    if (path === blocked) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return actual.lstatSync(path, ...args);
  });
  try {
    expect(() => inspectBuildCache()).toThrow(/permission denied/);
  } finally {
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  }
});

test("receipt formatting and property order preserve logical ownership for setup and cleanup", async () => {
  const { projects, populate } = fixture();
  populate();
  const report = inspectBuildCache();
  for (const { paths } of projects) {
    writeFileSync(
      join(paths.directory, ".workbench-build.json"),
      JSON.stringify(Object.fromEntries(Object.entries(paths.identity).reverse()), null, 2),
    );
    expect(() => {
      prepareBuild(paths);
    }).not.toThrow();
  }
  await pruneBuildCache(report, false, true);
  expect(projects.every(({ paths }) => !existsSync(paths.directory))).toBe(true);
});

test("checkout pruning includes nested roots and environments without a recursive option", async () => {
  const { projects, populate, run } = fixture();
  populate();
  const { root, paths } = required(projects[0], "Fixture value projects[0]");
  const nested = join(root, "library", "nested");
  mkdirSync(nested);
  const child = buildPaths(root, nested, "guix", {}, false);
  prepareBuild(child);
  const removed = await pruneBuildCache(inspectBuildCache(root), false, true);
  expect(new Set(removed.map((entry) => entry.directory))).toEqual(new Set([paths.directory, child.directory]));
  expect(existsSync(child.directory)).toBe(false);
  expect(existsSync(child.dependencies)).toBe(true);
  expect(existsSync(required(projects[1], "Expected fixture value: projects[1]").paths.directory)).toBe(true);
  await pruneBuildCache(inspectBuildCache(root), true, true);
  expect(existsSync(child.dependencies)).toBe(false);
  expect(run(root, "cache", "prune", "--recursive").stderr).toContain("unknown option '--recursive'");
});

test("container receipts retain a Windows host checkout identity on a Linux guest", async () => {
  const { projects } = fixture();
  vi.stubEnv("WORKBENCH_CONTAINER_CHECKOUT", "C:\\Projects\\consumer");
  const paths = buildPaths(
    required(projects[0], "Expected fixture value: projects[0]").root,
    required(projects[0], "Expected fixture value: projects[0]").root,
    "native",
    {},
    false,
  );
  prepareBuild(paths);
  const report = inspectBuildCache();
  expect(report.entries).toHaveLength(2);
  expect(report.entries.every((entry) => entry.identity.checkout === "C:\\Projects\\consumer")).toBe(true);
  await pruneBuildCache(report, true, true);
  expect(existsSync(paths.directory)).toBe(false);
});

test("interactive pruning selects checkouts and requires a separate confirmation before deleting", async () => {
  const { projects, populate } = fixture();
  populate();
  const tty = terminal();
  try {
    const report = inspectBuildCache();
    const pending = chooseCachePrune(report, false, tty.input, tty.output);
    tty.key("down");
    tty.key("down");
    tty.key("space");
    tty.key("return");
    expect(report.entries.every((entry) => existsSync(entry.directory))).toBe(true);
    expect(tty.text()).toContain("Y deletes; any other key cancels.");
    tty.key("y");
    const selected = await pending;
    expect(
      required(selected, "Expected fixture value: selected").entries.map((entry) => entry.identity.checkout),
    ).toEqual([required(projects[1], "Expected fixture value: projects[1]").root]);
    await pruneBuildCache(required(selected, "Chosen cache report"), false, true);
    expect(existsSync(required(projects[1], "Expected fixture value: projects[1]").paths.directory)).toBe(false);
    expect(existsSync(required(projects[0], "Expected fixture value: projects[0]").paths.directory)).toBe(true);
    expect(projects.every(({ paths }) => existsSync(paths.dependencies))).toBe(true);
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount("keypress")).toBe(0);
  } finally {
    tty.input.destroy();
    tty.output.destroy();
  }
});

test.each(["escape", "decline", "empty", "all"])(
  "interactive pruning handles %s without unintended deletions",
  async (choice) => {
    const { populate } = fixture();
    populate();
    const report = inspectBuildCache();
    const tty = terminal();
    try {
      const pending = chooseCachePrune(report, true, tty.input, tty.output);
      if (choice === "escape") tty.key("escape");
      else if (choice === "decline") {
        tty.key("return");
        tty.key("return");
      } else {
        tty.key("down");
        tty.key("space");
        if (choice === "all") {
          tty.key("up");
          tty.key("space");
        }
        tty.key("return");
        if (choice === "all") tty.key("y");
      }
      const selected = await pending;
      if (choice === "all")
        expect(required(selected, "Expected fixture value: selected").entries).toEqual(report.entries);
      else if (choice === "empty") expect(required(selected, "Expected fixture value: selected").entries).toEqual([]);
      else expect(selected).toBeUndefined();
      expect(report.entries.every((entry) => existsSync(entry.directory))).toBe(true);
      expect(tty.input.isRaw).toBe(false);
    } finally {
      tty.input.destroy();
      tty.output.destroy();
    }
  },
);

test("pruning previews by default, preserves dependencies unless selected, and never removes shared downloads or tools", async () => {
  const { cache, projects, populate } = fixture();
  const [first, second] = projects;
  populate();
  for (const name of ["downloads", "toolchains"]) {
    mkdirSync(join(cache, name), { recursive: true });
    writeFileSync(join(cache, name, "shared"), "retain");
  }
  mkdirSync(join(cache, "dependencies/ruby"), { recursive: true });
  writeFileSync(join(cache, "dependencies/ruby/shared-gem"), "retain shared Ruby installation");
  const report = inspectBuildCache(required(first, "Expected fixture value: first").root);
  const candidates = pruneBuildCache(report);
  expect(candidates.map((entry) => entry.directory)).toEqual([
    required(first, "Expected fixture value: first").paths.directory,
  ]);
  expect(existsSync(required(first, "Expected fixture value: first").paths.directory)).toBe(true);
  await pruneBuildCache(report, false, true);
  expect(existsSync(required(first, "Expected fixture value: first").paths.directory)).toBe(false);
  expect(existsSync(required(first, "Expected fixture value: first").paths.dependencies)).toBe(true);
  expect(existsSync(required(second, "Expected fixture value: second").paths.directory)).toBe(true);
  await pruneBuildCache(inspectBuildCache(required(first, "Expected fixture value: first").root), true, true);
  expect(existsSync(required(first, "Expected fixture value: first").paths.dependencies)).toBe(false);
  for (const name of ["downloads", "toolchains"])
    expect(readFileSync(join(cache, name, "shared"), "utf8")).toBe("retain");
  await pruneBuildCache(inspectBuildCache(undefined, true), true, true);
  expect(inspectBuildCache().entries).toEqual([]);
  expect(readFileSync(join(cache, "dependencies/ruby/shared-gem"), "utf8")).toBe("retain shared Ruby installation");
});

test("a busy root prevents the whole deletion set and releases locks acquired earlier", async () => {
  const { projects, populate } = fixture();
  populate();
  const report = inspectBuildCache();
  const ordered = [...projects].sort((a, b) => a.root.localeCompare(b.root));
  await withBuildLock(required(ordered[1], "Expected fixture value: ordered[1]").paths, async () => {
    await expect(pruneBuildCache(report, true, true)).rejects.toThrow(/active/);
  });
  for (const { paths } of projects) expect(existsSync(paths.directory)).toBe(true);
  expect(withBuildLock(required(ordered[0], "Expected fixture value: ordered[0]").paths, () => "released")).toBe(
    "released",
  );
});

test("changed, malformed, and relocated ownership receipts fail before deletion", async () => {
  const { projects, populate } = fixture();
  populate();
  const report = inspectBuildCache();
  const last = report.entries.at(-1),
    receipt = join(required(last, "Expected fixture value: last").directory, ".workbench-dependencies.json");
  writeFileSync(
    receipt,
    JSON.stringify({ ...required(last, "Expected fixture value: last").identity, root: "library" }),
  );
  await expect(pruneBuildCache(report, true, true)).rejects.toThrow(/ownership changed/);
  for (const { paths } of projects) expect(existsSync(paths.directory)).toBe(true);
  expect(() => inspectBuildCache()).toThrow(/ownership does not match/);
  writeFileSync(
    receipt,
    JSON.stringify({ ...required(last, "Expected fixture value: last").identity, root: "../outside" }),
  );
  expect(() => inspectBuildCache()).toThrow(/unsafe relative path/);
  writeFileSync(receipt, "null");
  expect(() => inspectBuildCache()).toThrow(/invalid build ownership/);
  const unaffected = projects.find(
    (project) => project.root !== required(last, "Expected fixture value: last").identity.checkout,
  );
  expect(inspectBuildCache(required(unaffected, "Expected fixture value: unaffected").root).entries).toHaveLength(2);
});

test.skipIf(process.platform === "win32")(
  "cache inspection rejects redirected namespaces and counts links without following targets",
  async () => {
    const { base, cache, projects, populate } = fixture();
    populate();
    const { paths } = required(projects[0], "Fixture value projects[0]");
    const report = inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root);
    const output = report.entries.find((entry) => entry.kind === "builds");
    const outside = join(base, "outside");
    writeFileSync(outside, "private target");
    symlinkSync(outside, join(paths.directory, "link"));
    linkSync(join(paths.directory, "output"), join(paths.directory, "hardlink"));
    const updated = inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root).entries.find(
      (entry) => entry.kind === "builds",
    );
    expect(required(updated, "Expected fixture value: updated").bytes).toBe(
      required(output, "Expected fixture value: output").bytes +
        Buffer.byteLength(outside) +
        Buffer.byteLength("build output"),
    );
    await pruneBuildCache(
      inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root),
      false,
      true,
    );
    expect(readFileSync(outside, "utf8")).toBe("private target");
    symlinkSync(base, join(cache, "builds/000000000000000000000000"));
    expect(() => inspectBuildCache()).toThrow(/symlinks/);
  },
);

test("cache CLI defaults to this checkout inside a project and all outside, supports --all and previews every deletion", () => {
  const { base, cache, projects, populate, run, json } = fixture();
  populate();
  const first = projects[0];
  expect(json(required(first, "Expected fixture value: first").root, "cache").entries).toHaveLength(2);
  expect(json(join(required(first, "Expected fixture value: first").root, "library"), "cache").checkout).toBe(
    required(first, "Expected fixture value: first").root,
  );
  expect(json(required(first, "Expected fixture value: first").root, "cache", "--all").entries).toHaveLength(4);
  expect(json(base, "cache").entries).toHaveLength(4);
  expect(json(base, "cache", "prune")).toMatchObject({ checkout: null, applied: false });
  expect(json(base, "cache", "prune").entries).toHaveLength(2);
  expect(
    json(required(first, "Expected fixture value: first").root, "cache", "prune", "--dependencies").entries,
  ).toHaveLength(2);
  expect(
    json(required(first, "Expected fixture value: first").root, "cache", "--all", "prune", "--dependencies").entries,
  ).toHaveLength(4);
  for (const { paths } of projects) expect(existsSync(paths.directory)).toBe(true);
  const table = run(base, "cache");
  expect(table.status, table.stderr).toBe(0);
  for (const { root } of projects) expect(table.stdout).toContain(root);
  expect(table.stdout).toContain("DEPENDENCIES");
  expect(run(base, "--help").stdout).toMatch(/^ {2}cache /m);
  expect(run(base, "complete", "--", "cache", "--a").stdout).toBe("--all\n");
  const removed = json(
    required(first, "Expected fixture value: first").root,
    "cache",
    "prune",
    "--all",
    "--dependencies",
    "--apply",
  );
  expect(removed.applied).toBe(true);
  for (const { paths } of projects) expect(existsSync(paths.directory)).toBe(false);
  expect(json(base, "cache").entries).toEqual([]);
  expect(existsSync(join(cache, "downloads/pnpm"))).toBe(true);
});

test("checkout storage overrides select one cache root without migrating or deleting previous storage", () => {
  const { base, cache, projects, populate, json } = fixture();
  populate();
  const first = projects[0],
    alternate = join(base, "other cache");
  writeFileSync(
    join(required(first, "Expected fixture value: first").root, "workbench/local.toml"),
    `[storage]\nroot=${JSON.stringify(alternate.replaceAll("\\", "/"))}\n`,
  );
  expect(json(required(first, "Expected fixture value: first").root, "cache", "--all")).toMatchObject({
    storageRoot: alternate,
    entries: [],
  });
  expect(existsSync(alternate)).toBe(false);
  expect(json(base, "cache").storageRoot).toBe(cache);
  expect(json(base, "cache").entries).toHaveLength(4);
});

test("an explicit checkout selects and prunes one removed project from outside, and conflicts with --all", () => {
  const { base, projects, populate, run, json } = fixture();
  populate();
  const [first, second] = projects;
  rmSync(required(second, "Expected fixture value: second").root, { recursive: true });
  const report = json(base, "cache", "--checkout", required(second, "Expected fixture value: second").root);
  expect(report.checkout).toBe(required(second, "Expected fixture value: second").root);
  expect(report.entries).toHaveLength(2);
  expect(
    report.entries.every(
      (entry: { identity: { checkout: string } }) =>
        entry.identity.checkout === required(second, "Expected fixture value: second").root,
    ),
  ).toBe(true);
  for (const command of [["cache"], ["cache", "prune", "--apply"]] as const) {
    const invalid = run(
      base,
      ...command,
      "--all",
      "--checkout",
      required(second, "Expected fixture value: second").root,
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("select --all or --checkout");
  }
  expect(existsSync(required(second, "Expected fixture value: second").paths.directory)).toBe(true);
  const removed = json(
    base,
    "cache",
    "--checkout",
    required(second, "Expected fixture value: second").root,
    "prune",
    "--dependencies",
    "--apply",
  );
  expect(removed.entries).toHaveLength(2);
  expect(existsSync(required(second, "Expected fixture value: second").paths.directory)).toBe(false);
  expect(existsSync(required(second, "Expected fixture value: second").paths.dependencies)).toBe(false);
  expect(existsSync(required(first, "Expected fixture value: first").paths.directory)).toBe(true);
});

test("deletion progress counts actual removals while every selected root remains locked", async () => {
  const { projects, populate } = fixture();
  populate();
  const report = inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root);
  const events: (string | number)[][] = [];
  const progress = {
    begin: (total: number) => events.push(["begin", total]),
    start: (label: string) => {
      expect(
        existsSync(buildLockDirectory(required(projects[0], "Expected fixture value: projects[0]").paths.identity)),
      ).toBe(true);
      events.push(["start", label]);
    },
    complete: () => events.push(["complete"]),
  };
  const removed = await pruneCache(
    report,
    required(projects[0], "Expected fixture value: projects[0]").root,
    true,
    true,
    progress,
  );
  expect(removed.entries).toHaveLength(2);
  expect(events.map((event) => event[0])).toEqual(["begin", "start", "complete", "start", "complete"]);
  expect(events[0]).toEqual(["begin", 2]);
  expect(events.filter((event) => event[0] === "start").map((event) => event[1])).toEqual([
    "widget / . / builds",
    "widget / . / dependencies",
  ]);
  expect(
    existsSync(buildLockDirectory(required(projects[0], "Expected fixture value: projects[0]").paths.identity)),
  ).toBe(false);
  expect(inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root).entries).toEqual([]);
});

test("image reports distinguish tag deletion, retained containers, and Docker disk usage", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    printCacheReport({
      storageRoot: resolve("cache"),
      checkout: null,
      entries: [],
      images: {
        location: "local",
        issues: [],
        entries: [
          imageEntry({
            profile: "native",
            reference: "registry.example/project:tag",
            bytes: 1000,
            blockedReason: "attached",
            blockedBy: "referenced by a Docker container",
          }),
        ],
      },
    });
    const output = log.mock.calls.map(([text]) => String(text)).join("\n");
    expect(output).toContain("shared layers");
    expect(output).toContain("Image-tag deletion preserves build cache");
    expect(output).toContain("select a dedicated BuildKit builder separately");
    expect(output).toContain("including stopped containers");
    expect(output).toContain("docker ps -a");
    expect(output).toContain("No option forces removal of other containers");
    const filesystemTable = log.mock.calls.find(([text]) => String(text).includes("| CHECKOUT"));
    expect(filesystemTable).toBeUndefined();
    expect(output).toContain("No owned filesystem caches found.");
    expect(output).toContain("Estimated size: 0 B builds;");
    expect(output).toContain("logical image sizes; reclaimed space unknown");
  } finally {
    log.mockRestore();
  }
});

test.each(["images", "builders"])("empty %s reports stay within the requested Docker scope", (checkout) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    printCacheReport({ storageRoot: resolve("cache"), checkout, entries: [] });
    const output = log.mock.calls.map(([text]) => String(text)).join("\n");
    expect(output).toContain(
      checkout === "images" ? "No owned local image tags found." : "No owned Docker builder stores found.",
    );
    expect(output).not.toContain("filesystem");
    expect(output).not.toContain("Estimated size:");
  } finally {
    log.mockRestore();
  }
});

test("redirected cache deletion prints start and completion summaries without a post-deletion table", () => {
  const { projects, populate, run } = fixture();
  populate();
  const result = run(
    required(projects[0], "Expected fixture value: projects[0]").root,
    "cache",
    "prune",
    "--checkout",
    required(projects[0], "Expected fixture value: projects[0]").root,
    "--dependencies",
    "--apply",
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("Deleting 2 cache items…");
  expect(lines[1]).toMatch(/^Removed 2\/2 cache items in \d+\.\d s\.$/);
  expect(result.stdout).not.toContain("\u001b");
  expect(inspectBuildCache(required(projects[0], "Expected fixture value: projects[0]").root).entries).toEqual([]);
});

test("cancellation drains the active deletion, preserves remaining items, and releases locks and handlers", async () => {
  const { projects, populate } = fixture();
  populate();
  const { root, paths } = required(projects[0], "Fixture value projects[0]");
  const entered = Promise.withResolvers<undefined>(),
    finish = Promise.withResolvers<undefined>();
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    entered.resolve(undefined);
    await finish.promise;
    await removeDirectory(path, options);
  });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const before = process.listenerCount("message");
  const program = new Command();
  registerCacheCommands(program, root);
  const pending = program.parseAsync([
    "node",
    "workbench",
    "cache",
    "prune",
    "--checkout",
    root,
    "--dependencies",
    "--apply",
  ]);
  const outcome = expect(pending).rejects.toThrow(/Cache pruning cancelled/);
  // Startup failures must fail this test rather than leave its synchronization gate waiting forever.
  void outcome.catch(() => undefined);
  try {
    await Promise.race([entered.promise, pending]);
    process.emit("message", { type: "workbench-check-cancel" }, undefined);
    expect(existsSync(buildLockDirectory(paths.identity))).toBe(true);
    finish.resolve(undefined);
    await outcome;
    expect(existsSync(paths.directory)).toBe(false);
    expect(existsSync(paths.dependencies)).toBe(true);
    expect(existsSync(buildLockDirectory(paths.identity))).toBe(false);
    expect(process.listenerCount("message")).toBe(before);
    expect(output.mock.calls.map((call) => call[0]).join("")).toContain("Stopped after removing 1/2");
  } finally {
    finish.resolve(undefined);
    await Promise.allSettled([pending, outcome]);
    output.mockRestore();
  }
});
