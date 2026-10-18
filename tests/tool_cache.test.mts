import { promised } from "./fixtures/promised.mjs";
import { terminal } from "./fixtures/terminal.mjs";
import { completedProcess } from "./fixtures/process.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectToolCache, pruneToolCache, prunableTools } from "../src/tool-cache.ts";
import { chooseCachePrune, printCacheReport, groupCacheReport, inspectCache, pruneCache } from "../src/build-cache.ts";
import { withBuildLock } from "../src/builds.ts";
import { withToolCacheUse, withToolCacheUseAsync, toolCacheBlocker } from "../src/tool-cache-lock.ts";
import { withCacheLockSync } from "../src/cache-lock.ts";
import { recordResultTools, refreshToolReferences, inspectToolReferences } from "../src/tool-references.ts";
import { prepareBuild, buildPaths } from "../src/builds.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    execFile: vi.fn(
      (
        command: string,
        args: string[],
        options: import("node:child_process").SpawnSyncOptions,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const result = spawnSync(command, args, options);
        callback(
          result.status === 0 ? null : new Error(String(result.stderr)),
          String(result.stdout),
          String(result.stderr),
        );
      },
    ),
  };
});
const temporary: string[] = [];
const realSpawn = vi.mocked(spawnSync).getMockImplementation();
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockImplementation(required(realSpawn, "Expected fixture value"));
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-tool-cache-")));
  temporary.push(base);
  const cache = join(base, "cache"),
    root = join(base, "project"),
    distribution = join(base, "distribution");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(distribution, "scripts"), { recursive: true });
  mkdirSync(join(distribution, "languages"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[language_root]]\nlanguage="ruby"\npath="."\n',
  );
  writeFileSync(join(distribution, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
  writeFileSync(join(distribution, ".node-version"), process.versions.node);
  writeFileSync(join(distribution, "scripts/native-assets.json"), "{}");
  for (const [name, value] of Object.entries({
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_STATE_HOME: join(base, "state"),
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_STORAGE_EXTERNAL: "true",
    WORKBENCH_STORAGE_ROOT: undefined,
    WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
    WORKBENCH_TOOLCHAIN: undefined,
    WORKBENCH_TOOLCHAIN_ROOT: undefined,
    RUSTUP_HOME: join(base, "rustup"),
    UV_PYTHON_INSTALL_DIR: join(base, "python"),
  }))
    vi.stubEnv(name, value);
  const install = (tool: string, version: string, identity = "a".repeat(64), variant = identity.slice(0, 16)) => {
    const path = join(cache, "toolchains", tool, version, `${process.platform}-${process.arch}`, variant);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".workbench-artifact"), identity + "\n");
    writeFileSync(join(path, "binary"), "example tool bytes");
    return path;
  };
  return { base, cache, root, distribution, install };
}

test("inspection is read-only, separates installation identities, and preserves foreign or partial paths", async () => {
  const f = fixture();
  expect(inspectToolCache(f.root)).toMatchObject({ entries: [], issues: [] });
  expect(existsSync(f.cache)).toBe(false);
  const first = f.install("ruby", "4.0.7");
  const second = f.install("ruby", "4.0.7", "a".repeat(64), "a".repeat(16) + "-other-host");
  const partial = f.install("ruby", "4.0.7", "a".repeat(64), "unfinished.partial");
  const foreign = join(dirname(first), "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "private"), "keep");
  const report = inspectToolCache(f.root);
  expect(report.entries.map((e) => e.directory).sort()).toEqual([first, second].sort());
  expect(new Set(report.entries.map((e) => e.id)).size).toBe(2);
  expect(report.entries.every((e) => e.bytes > 0)).toBe(true);
  expect(groupCacheReport({ storageRoot: f.cache, checkout: null, entries: [], tools: report })).toMatchObject([
    { checkout: "Tools", rows: [{ root: "ruby" }] },
  ]);
  expect(pruneToolCache(report, f.root)).toHaveLength(2);
  expect(existsSync(first)).toBe(true);
  await pruneToolCache(report, f.root, true);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
  expect(existsSync(partial)).toBe(true);
  expect(readFileSync(join(foreign, "private"), "utf8")).toBe("keep");
});

test("configured pins do not prevent explicit cache cleanup", async () => {
  const f = fixture(),
    hash = "b".repeat(64);
  writeFileSync(join(f.root, ".ruby-version"), "4.0.7");
  writeFileSync(
    join(f.distribution, "scripts/native-assets.json"),
    JSON.stringify({
      ruby: {
        "4.0.7": {
          [`${process.platform}-${process.arch}`]: {
            sha256: hash,
            url: "https://example.test/ruby.tar.gz",
            format: "tar",
            strip: 1,
            bin: "bin",
            authenticationUnavailable: "fixture",
          },
        },
      },
    }),
  );
  const current = join(f.cache, "toolchains/ruby/4.0.7", `${process.platform}-${process.arch}`, hash.slice(0, 16));
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, ".workbench-artifact"), hash);
  const old = f.install("ruby", "4.0.7", hash, hash.slice(0, 16) + "-old-host");
  const report = inspectToolCache(f.root);
  expect(report.entries.every((e) => !e.protected.length)).toBe(true);
  expect((await pruneToolCache(report, f.root, true)).map((e) => e.directory).sort()).toEqual([current, old].sort());
  expect(existsSync(current)).toBe(false);
});

test("complete deletion preflight rejects changed receipts, live writers, and active builds", async () => {
  const f = fixture(),
    first = f.install("ruby", "4.0.6"),
    second = f.install("php", "8.5.10");
  const report = inspectToolCache(f.root);
  await withCacheLockSync(first, async () => {
    await expect(pruneToolCache(report, f.root, true)).rejects.toThrow(/busy|recovery/);
  });
  await withBuildLock(
    { identity: { checkout: f.root, root: ".", environment: "native", fingerprint: "0".repeat(24) } },
    async () => {
      const current = inspectToolCache(f.root);
      expect(current.entries.every((entry) => entry.protected.some((reason) => reason.includes("lock")))).toBe(true);
      expect(pruneToolCache(current, f.root)).toEqual([]);
      await expect(pruneToolCache(report, f.root, true)).rejects.toThrow(/active/);
    },
  );
  writeFileSync(join(first, ".workbench-artifact"), "c".repeat(64));
  await expect(pruneToolCache(report, f.root, true)).rejects.toThrow(/changed/);
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(true);
});

test("symbolic installation paths never become a deletion target", async () => {
  const f = fixture(),
    directory = f.install("php", "8.5.10"),
    foreign = join(f.base, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep"), "user data");
  const report = inspectToolCache(f.root);
  rmSync(directory, { recursive: true });
  symlinkSync(foreign, directory, "junction");
  await expect(pruneToolCache(report, f.root, true)).rejects.toThrow(/changed/);
  expect(readFileSync(join(foreign, "keep"), "utf8")).toBe("user data");
});

function managers(f: ReturnType<typeof fixture>) {
  const rust = join(f.base, "rustup"),
    python = join(f.base, "python");
  const rustNames = ["1.98.1-x86_64-unknown-linux-gnu", "1.99.0-x86_64-unknown-linux-gnu"];
  for (const name of rustNames) {
    const path = join(rust, "toolchains", name, "lib/rustlib");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "rust-installer-version"), "3");
  }
  const key = "cpython-3.14.8-linux-x86_64-gnu",
    path = join(python, key, "bin/python3.14");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "python");
  const real = vi.mocked(spawnSync).getMockImplementation();
  vi.mocked(spawnSync).mockImplementation((command, args = [], options) => {
    let stdout = "";
    if (command === "rustup") {
      if (args[1] === "list")
        stdout = rustNames
          .filter((name) => existsSync(join(rust, "toolchains", name)))
          .map((name, i) => `${name}${i === 1 ? " (active, default)" : ""} ${join(rust, "toolchains", name)}`)
          .join("\n");
      else if (args[1] === "uninstall")
        rmSync(join(rust, "toolchains", required(args[2], "Expected fixture value")), { recursive: true });
      else throw new Error("unexpected rustup call");
    } else if (command === "uv") {
      if (args[1] === "dir") stdout = python;
      else if (args[1] === "list")
        stdout = JSON.stringify(
          existsSync(path)
            ? [
                { key, path, version: "3.14.8" },
                { key, path, version: "3.14.8" },
              ]
            : [],
        );
      else if (args[1] === "uninstall")
        rmSync(join(python, required(args.at(-1), "Expected fixture value")), { recursive: true });
      else throw new Error("unexpected uv call");
    } else return required(real, "Expected fixture value")(command, args, options);
    return completedProcess({ stdout });
  });
  return { rust, python, rustNames, key, path };
}

test("managed Python is deduplicated; rustup owns removal and configured defaults do not pin caches", async () => {
  const f = fixture(),
    m = managers(f);
  const report = inspectToolCache(f.root);
  expect(report.entries).toHaveLength(3);
  expect(report.entries.every((e) => !e.protected.length)).toBe(true);
  const removed = await pruneToolCache(report, f.root, true);
  expect(removed.map((e) => e.tool).sort()).toEqual(["python", "rust", "rust"]);
  expect(existsSync(m.path)).toBe(false);
  expect(existsSync(join(m.rust, "toolchains", required(m.rustNames[0], "Expected fixture value")))).toBe(false);
  expect(existsSync(join(m.rust, "toolchains", required(m.rustNames[1], "Expected fixture value")))).toBe(false);
  expect(spawnSync).toHaveBeenCalledWith(
    "uv",
    ["python", "uninstall", "--install-dir", m.python, m.key],
    expect.anything(),
  );
});

test("manager errors are visible, and a failed uninstall reports partial completion", async () => {
  const f = fixture();
  managers(f);
  const report = inspectToolCache(f.root);
  const previous = vi.mocked(spawnSync).getMockImplementation();
  vi.mocked(spawnSync).mockImplementation((command, args = [], options) =>
    command === "uv" && args[1] === "uninstall"
      ? completedProcess({ status: 1, stderr: "manager refused" })
      : required(previous, "Expected fixture value")(command, args, options),
  );
  await expect(pruneToolCache(report, f.root, true)).rejects.toThrow(/after removing 0/);
  vi.mocked(spawnSync).mockImplementation((command: string, args, options) =>
    command === "uv"
      ? completedProcess({ status: 1, stderr: "inventory unavailable" })
      : required(previous, "Expected fixture value")(command, args, options),
  );
  expect(inspectToolCache(f.root).issues.join(" ")).toContain("inventory unavailable");
});

test("interactive shared pruning starts with no selections and cancellation preserves everything", async () => {
  const f = fixture(),
    path = f.install("ruby", "4.0.6"),
    report = inspectToolCache(f.root);
  const { input, output } = terminal();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => input;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const choice = chooseCachePrune(
    { storageRoot: f.cache, checkout: null, entries: [], tools: report },
    false,
    input,
    output,
  );
  input.write("\u001b");
  expect(await choice).toBeUndefined();
  expect(existsSync(path)).toBe(true);
  expect(rendered).toContain("Select caches");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  printCacheReport({ storageRoot: f.cache, checkout: null, entries: [], tools: report });
  expect(log).toHaveBeenCalled();
});

test("CLI previews shared installations separately and rejects irrelevant scope options", () => {
  const f = fixture(),
    path = f.install("ruby", "4.0.6");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [resolve(import.meta.dirname, "../bin/workbench.mjs"), ...args], {
      cwd: f.base,
      env: process.env,
      encoding: "utf8",
    });
  const preview = run("cache", "prune", "--checkout", "tools", "--json");
  expect(preview.status, preview.stderr).toBe(0);
  const parsed = JSON.parse(preview.stdout) as { applied: boolean; tools: { entries: unknown[] } };
  expect(parsed.applied).toBe(false);
  expect(parsed.tools.entries).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  expect(run("cache", "--checkout", "tools", "--all").status).not.toBe(0);
  const applied = run("cache", "prune", "--checkout", "tools", "--apply", "--json");
  expect(applied.status, applied.stderr).toBe(0);
  expect(existsSync(path)).toBe(false);
});

test("Tools uses language rows and the ordinary selector prunes its children only after confirmation", async () => {
  const f = fixture();
  const ruby = f.install("ruby", "4.0.6"),
    php = f.install("php", "8.5.10");
  const report = { storageRoot: f.cache, checkout: null, entries: [], tools: inspectToolCache(f.root) };
  expect(groupCacheReport(report)).toMatchObject([
    { checkout: "Tools", count: 2, rows: [{ root: "php" }, { root: "ruby" }] },
  ]);
  const tty = () => {
    const { input, output } = terminal();
    input.isTTY = true;
    output.isTTY = true;
    input.setRawMode = () => input;
    output.resume();
    return { input, output };
  };
  const none = tty();
  const empty = chooseCachePrune(report, false, none.input, none.output);
  none.input.write("\r");
  expect(
    required(
      required(await empty, "Expected fixture value: (await empty)").tools,
      "Expected fixture value: (await empty).tools",
    ).entries,
  ).toEqual([]);
  expect(existsSync(ruby)).toBe(true);
  const all = tty();
  const choice = chooseCachePrune(report, false, all.input, all.output);
  all.input.write(" \ry");
  const selected = await choice;
  expect(
    required(required(selected, "Expected fixture value: selected").tools, "Expected fixture value: selected.tools")
      .entries,
  ).toHaveLength(2);
  await pruneToolCache(
    required(required(selected, "Expected fixture value: selected").tools, "Expected fixture value"),
    f.root,
    true,
  );
  expect(existsSync(ruby)).toBe(false);
  expect(existsSync(php)).toBe(false);
});

function result(
  f: ReturnType<typeof fixture>,
  tools: { tool: string; version: string; directory: string }[] | { tool: string; version: string }[],
) {
  const paths = buildPaths(f.root, f.root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "compiled result");
  recordResultTools({
    directory: paths.directory,
    storageRoot: paths.storageRoot,
    kind: "builds",
    identity: paths.identity,
    tools,
  });
  return paths;
}

test("a retained result protects its tools outside the project even when the checkout disappears", async () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  const paths = result(f, [{ tool: "ruby", version: "4.0.7", directory: sdk }]);
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toEqual([]);
  rmSync(f.root, { recursive: true });
  expect(inspectToolReferences().results.map((r) => r.directory)).toEqual([paths.directory]);
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toEqual([]);
  rmSync(paths.directory, { recursive: true });
  expect(refreshToolReferences().results).toEqual([]);
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toHaveLength(1);
});

test("tools-only cleanup preserves dependencies of retained results; selecting both deletes in one operation", async () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  const paths = result(f, [{ tool: "ruby", version: "4.0.7", directory: sdk }]);
  const only = await pruneCache(inspectCache(undefined, false, "tools"), undefined, false, true);
  expect(required(only.tools, "Expected fixture value: only.tools").entries).toEqual([]);
  expect(existsSync(sdk)).toBe(true);
  const all = await pruneCache(inspectCache(f.root), f.root, false, true);
  expect(required(all.tools, "Expected fixture value: all.tools").entries.map((e) => e.directory)).toEqual([sdk]);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(sdk)).toBe(false);
  expect(inspectToolReferences().results).toEqual([]);
});

test("a new retained result between preview and deletion protects the complete SDK selection", async () => {
  const f = fixture(),
    first = f.install("ruby", "4.0.7"),
    second = f.install("php", "8.5.10");
  const preview = inspectToolCache();
  result(f, [{ tool: "ruby", version: "4.0.7", directory: first }]);
  await expect(pruneToolCache(preview, undefined, true)).rejects.toThrow(/protection changed/);
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(true);
});

test("empty build preparation and logs alone do not pin SDKs; corrupt reference indexes preserve tools", async () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  const paths = buildPaths(f.root, f.root, "native", {}, false);
  prepareBuild(paths);
  recordResultTools({
    directory: paths.directory,
    storageRoot: paths.storageRoot,
    kind: "builds",
    identity: paths.identity,
    tools: [{ tool: "ruby", version: "4.0.7", directory: sdk }],
  });
  mkdirSync(join(paths.directory, "check-logs"));
  writeFileSync(join(paths.directory, "check-logs/log"), "diagnostics");
  expect(
    required(inspectToolCache().entries[0], "Expected fixture value: inspectToolCache().entries[0]").protected,
  ).toEqual([]);
  const index = join(f.base, "state/cache-tool-references.json");
  writeFileSync(index, "{broken");
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toEqual([]);
  expect(refreshToolReferences().issues.join(" ")).toContain("could not be verified");
  expect(readFileSync(index, "utf8")).toBe("{broken");
});

test("broken project settings do not pin unused SDKs", async () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  writeFileSync(join(f.root, "workbench/config.toml"), "invalid TOML [");
  const report = inspectToolCache(f.root);
  expect((await pruneToolCache(report, f.root, true)).map((e) => e.directory)).toEqual([sdk]);
});

test("native command leases protect SDKs through asynchronous work and release on failure", async () => {
  const f = fixture();
  f.install("ruby", "4.0.7");
  expect(() =>
    withToolCacheUse(() => {
      expect(pruneToolCache(inspectToolCache())).toEqual([]);
      throw new Error("command failed");
    }),
  ).toThrow("command failed");
  expect(toolCacheBlocker()).toBeUndefined();
  const ready = Promise.withResolvers<undefined>(),
    finish = Promise.withResolvers<undefined>();
  const work = withToolCacheUseAsync(async () => {
    ready.resolve(undefined);
    await finish.promise;
  });
  await ready.promise;
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toEqual([]);
  finish.resolve(undefined);
  await work;
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toHaveLength(1);
});

test("cache retain and forget are absent from the public command interface", () => {
  const f = fixture();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [resolve(import.meta.dirname, "../bin/workbench.mjs"), "cache", ...args], {
      cwd: f.root,
      env: process.env,
      encoding: "utf8",
    });
  expect(run("retain").status).not.toBe(0);
  expect(run("forget", f.root).status).not.toBe(0);
});

function tty() {
  const { input, output } = terminal();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => input;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += String(chunk);
  });
  return { input, output, rendered: () => rendered };
}

test("shared tools show partial size/count separately from projects, and fully pinned rows are disabled", async () => {
  const f = fixture(),
    pinned = f.install("ruby", "4.0.7"),
    free = f.install("php", "8.5.10");
  const paths = result(f, [{ tool: "ruby", version: "4.0.7", directory: pinned }]);
  const io = tty(),
    pending = chooseCachePrune(inspectCache(undefined, false, "tools"), false, io.input, io.output);
  expect(io.rendered()).toContain("Shared tools:");
  expect(io.rendered()).toContain("(1/2)");
  expect(io.rendered()).toContain("pinned");
  io.input.write("\ry");
  const chosen = await pending;
  expect(
    required(
      required(chosen, "Expected fixture value: chosen").tools,
      "Expected fixture value: chosen.tools",
    ).entries.map((e) => e.directory),
  ).toEqual([free]);
  await pruneCache(required(chosen, "Expected fixture value"), undefined, false, true);
  const disabled = tty(),
    cancel = chooseCachePrune(inspectCache(undefined, false, "tools"), false, disabled.input, disabled.output);
  expect(disabled.rendered()).toContain("[disabled]");
  disabled.input.write(" \r");
  expect(
    required(
      required(await cancel, "Expected fixture value: (await cancel)").tools,
      "Expected fixture value: (await cancel).tools",
    ).entries,
  ).toEqual([]);
  expect(existsSync(pinned)).toBe(true);
  expect(existsSync(paths.directory)).toBe(true);
});

test("changing project selection recomputes shared-tool eligibility and confirmation includes only deletable caches", async () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  result(f, [{ tool: "ruby", version: "4.0.7", directory: sdk }]);
  const io = tty(),
    pending = chooseCachePrune(inspectCache(f.root), false, io.input, io.output);
  expect(io.rendered()).toContain("Projects:");
  expect(io.rendered()).toContain("Shared tools:");
  // Select none: the retained project result pins the sole SDK, disabling Tools.
  io.input.write("\u001b[B ");
  expect(io.rendered().split("Shared tools:").at(-1)).toContain("[disabled]");
  // Select all: the result is removed in this selection, so Tools becomes eligible.
  io.input.write("\u001b[A \ry");
  const selected = await pending;
  expect(
    required(
      required(selected, "Expected fixture value: selected").tools,
      "Expected fixture value: selected.tools",
    ).entries.map((e) => e.directory),
  ).toEqual([sdk]);
  await pruneCache(required(selected, "Expected fixture value"), f.root, false, true);
  expect(existsSync(sdk)).toBe(false);
});

test("retained result dependencies on manager-owned runtimes are released with the result", async () => {
  const f = fixture(),
    m = managers(f);
  const paths = result(f, [
    { tool: "python", version: "3.14.8" },
    { tool: "rust", version: "1.98.1" },
  ]);
  const pinned = inspectToolCache();
  expect(
    pinned.entries
      .filter((entry) => entry.pinnedBy.includes(paths.directory))
      .map((entry) => entry.tool)
      .sort(),
  ).toEqual(["python", "rust"]);
  const removed = await pruneToolCache(pinned, undefined, true);
  expect(removed.map((entry) => entry.version)).toEqual(["1.99.0"]);
  expect(existsSync(m.path)).toBe(true);
  rmSync(paths.directory, { recursive: true });
  expect((await pruneToolCache(inspectToolCache(), undefined, true)).map((entry) => entry.tool).sort()).toEqual([
    "python",
    "rust",
  ]);
});

test("pruning reclaims a proven-dead local command lease without writing during inspection", async () => {
  const f = fixture();
  f.install("ruby", "4.0.7");
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  expect(child.status).toBe(0);
  const name = "retired-command",
    path = join(f.cache, "tool-users", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: child.pid, host: hostname(), token: name }));
  expect(toolCacheBlocker()).toBeUndefined();
  expect(existsSync(path)).toBe(true);
  expect(await pruneToolCache(inspectToolCache(), undefined, true)).toHaveLength(1);
  expect(existsSync(path)).toBe(false);
});

test("an active declared SDK lease leaves unrelated SDKs available for pruning", async () => {
  const f = fixture(),
    active = f.install("ruby", "4.0.7"),
    unused = f.install("php", "8.5.10");
  await withToolCacheUseAsync(async () => {
    const current = inspectToolCache();
    expect(
      required(
        current.entries.find((entry) => entry.directory === active),
        "Expected fixture value: current.entries.find((entry) => entry.directory === active)",
      ).protected.join(" "),
    ).toContain("active Workbench command");
    expect((await pruneToolCache(current, undefined, true)).map((entry) => entry.directory)).toEqual([unused]);
    expect(existsSync(active)).toBe(true);
  }, [{ tool: "ruby", version: "4.0.7", directory: active }]);
});

test("Tab opens subprojects; Enter returns to the parent and confirmation follows the selection", async () => {
  const f = fixture(),
    paths = result(f, []);
  const nested = join(f.root, "nested");
  mkdirSync(nested);
  const childPaths = buildPaths(f.root, nested, "native", {}, false);
  prepareBuild(childPaths);
  writeFileSync(join(childPaths.directory, "output"), "child result");
  const io = tty(),
    pending = chooseCachePrune(inspectCache(f.root), false, io.input, io.output);
  // Focus the project, open it, and deselect its root while keeping nested selected.
  io.input.write("\u001b[B\u001b[B\t ");
  expect(io.rendered()).toContain("nested");
  io.input.write("\r");
  expect(io.rendered()).toContain("[~]");
  // Returning to the parent did not confirm. A second Enter presents the footer.
  io.input.write("\r");
  const footer = io.rendered().lastIndexOf("Delete ");
  expect(footer).toBeGreaterThan(io.rendered().lastIndexOf(f.root));
  io.input.write("y");
  const chosen = await pending;
  expect(required(chosen, "Expected fixture value: chosen").entries.map((entry) => entry.directory)).toEqual([
    childPaths.directory,
  ]);
  await pruneCache(required(chosen, "Expected fixture value"), f.root, false, true);
  expect(existsSync(paths.directory)).toBe(true);
  expect(existsSync(childPaths.directory)).toBe(false);
});

test("Tools can be expanded and a single language selected without selecting its siblings", async () => {
  const f = fixture(),
    ruby = f.install("ruby", "4.0.7"),
    php = f.install("php", "8.5.10");
  const io = tty(),
    pending = chooseCachePrune(inspectCache(undefined, false, "tools"), false, io.input, io.output);
  // Start with nothing, focus Tools, open its languages, and select only PHP.
  io.input.write("\u001b[B \u001b[B\t \r\ry");
  const selected = await pending;
  expect(
    required(
      required(selected, "Expected fixture value: selected").tools,
      "Expected fixture value: selected.tools",
    ).entries.map((entry) => entry.directory),
  ).toEqual([php]);
  await pruneCache(required(selected, "Expected fixture value"), undefined, false, true);
  expect(existsSync(ruby)).toBe(true);
  expect(existsSync(php)).toBe(false);
});

test("installation locks remove only their SDK from the prune offer", async () => {
  const f = fixture(),
    locked = f.install("ruby", "4.0.7"),
    free = f.install("php", "8.5.10");
  await withCacheLockSync(locked, async () => {
    const report = inspectToolCache();
    expect(
      required(
        report.entries.find((entry) => entry.directory === locked),
        "Expected fixture value: report.entries.find((entry) => entry.directory === locked)",
      ).protected,
    ).toContain("installation or cleanup lock");
    expect((await pruneToolCache(report, undefined, true)).map((entry) => entry.directory)).toEqual([free]);
  });
  expect(existsSync(locked)).toBe(true);
});

test.each([false, true])("command and lease release failures are both preserved (async=%s)", async (asynchronous) => {
  const f = fixture(),
    failure = new Error("original command failure");
  const action = () => {
    const leases = join(f.cache, "tool-users");
    const lease = readdirSync(leases)[0];
    writeFileSync(join(leases, required(lease, "Expected fixture value"), "owner.json"), "changed owner");
    throw failure;
  };
  let caught;
  try {
    if (asynchronous) await withToolCacheUseAsync(() => promised(() => action()), []);
    else withToolCacheUse(action, []);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError)) throw new Error("Expected aggregate lease failure");
  expect(caught.errors[0]).toBe(failure);
  expect((caught.errors[1] as Error).message).toContain("tool lease ownership changed");
  expect(readdirSync(join(f.cache, "tool-users"))).toHaveLength(1);
});

test("displayed protection text cannot grant or revoke deletion eligibility", () => {
  const f = fixture(),
    sdk = f.install("ruby", "4.0.7");
  const paths = result(f, [{ tool: "ruby", version: "4.0.7", directory: sdk }]);
  const report = inspectToolCache();
  const json = JSON.parse(JSON.stringify(report)) as typeof report;
  expect(required(json.entries[0], "Expected fixture value").protected).toEqual([
    `retained result: ${paths.directory}`,
  ]);
  expect(Object.keys(required(json.entries[0], "Expected fixture value")).sort()).toEqual([
    "bytes",
    "directory",
    "id",
    "identity",
    "pinnedBy",
    "platform",
    "protected",
    "provider",
    "tool",
    "version",
  ]);
  required(report.entries[0], "Expected fixture value: report.entries[0]").protected = [];
  expect(prunableTools(report)).toEqual([]);
  expect(prunableTools(report, [paths.directory])).toHaveLength(1);
  withCacheLockSync(sdk, () => {
    const locked = inspectToolCache();
    required(locked.entries[0], "Expected fixture value: locked.entries[0]").protected = [
      `retained result: ${paths.directory}`,
    ];
    expect(prunableTools(locked, [paths.directory])).toEqual([]);
  });
  expect(existsSync(sdk)).toBe(true);
});
