import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { groupedCIMatrix } from "../src/ci-targets.ts";
import { ciMatrix } from "../src/ci.ts";
import { copySourceCheckout } from "../scripts/source-checkout.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "workbench-ci-cache-"));
  temporary.push(path);
  return path;
}

test("shared CI setup preserves every configured root and target", () => {
  const original = ciMatrix(repository);
  const shared = groupedCIMatrix(original);
  for (const [section, fields] of [
    ["native", ["os", "architecture", "runner", "node"]],
    ["compatibility", ["runtime", "version", "architecture", "runner", "node"]],
    ["environments", ["environment", "node"]],
  ]) {
    const key = (entry, path) => JSON.stringify([path, ...fields.map((field) => entry[field] ?? "")]);
    const before = original[section].include.map((entry) => key(entry, entry.path)).sort();
    const after = shared[section].include.flatMap((entry) => entry.paths.map((path) => key(entry, path))).sort();
    expect(after).toEqual(before);
  }
  expect(shared.native.include).toHaveLength(4);
  expect(shared.compatibility.include.filter((entry) => entry.runtime === "gcc")).toHaveLength(6);
  expect(
    shared.compatibility.include.filter((entry) => entry.runtime === "gcc").every((entry) => entry.paths.length === 2),
  ).toBe(true);
  expect(shared.environments.include).toHaveLength(2);
  expect(shared.devcontainer).toEqual(original.devcontainer);
});

test("grouped execution continues checking other roots after one fails", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    `import { appendFileSync } from "node:fs"; const args=process.argv.slice(2); appendFileSync("events.jsonl", JSON.stringify(args)+"\\n"); if(args.includes("bad")) process.exitCode=2;`,
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "environment"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', CHECK_ENVIRONMENT: "guix" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events).toHaveLength(2);
  expect(events[0]).toContain("bad");
  expect(events[1]).toContain("good");
  writeFileSync(join(root, "events.jsonl"), "");
  const output = join(root, "output");
  const native = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "native"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  expect(native.status).toBe(1);
  expect(readFileSync(output, "utf8")).toBe('roots=["good"]\n');
  const nativeEvents = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(nativeEvents).toHaveLength(3);
  expect(nativeEvents[2]).toContain("good");
  expect(nativeEvents[2]).toContain("checks");
  mkdirSync(join(root, "good/dist"), { recursive: true });
  writeFileSync(join(root, "good/dist/package.txt"), "verified fixture");
  writeFileSync(output, "");
  const releases = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "release"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', GITHUB_OUTPUT: output, RUNNER_TEMP: root },
    encoding: "utf8",
  });
  expect(releases.status).toBe(1);
  expect(readFileSync(output, "utf8")).toBe('roots=["good"]\n');
  expect(readFileSync(join(root, "release-artifacts/1.txt"), "utf8")).toBe("good\n");
  expect(existsSync(join(root, "release-artifacts/1.tar.gz"))).toBe(true);
  const releaseEvents = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(releaseEvents).toContainEqual([
    "checks",
    "run",
    "--role",
    "release-verify",
    "--path",
    "good",
    "--environment",
    "native",
  ]);
});

test("CI cache keys isolate runtime targets and exclude oversized installations", () => {
  const root = fixture();
  const checkout = join(root, "checkout");
  copySourceCheckout(repository, checkout);
  // This planning fixture never executes tools. Supply the selected Linux x64 artifacts on any test host.
  const assetsPath = join(checkout, "scripts/native-assets.json");
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  for (const versions of Object.values(assets))
    for (const platforms of Object.values(versions))
      if (platforms["linux-x64"]) platforms[`${process.platform}-${process.arch}`] = platforms["linux-x64"];
  writeFileSync(assetsPath, JSON.stringify(assets));
  const environment = join(root, "environment");
  const output = join(root, "output");
  const run = (version) => {
    writeFileSync(environment, "");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(checkout, "scripts/ci-cache.mjs")], {
      cwd: checkout,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify({ runtime: "node", version, paths: ["."] }),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
  };
  const versions = ciMatrix(repository)
    .compatibility.include.filter(({ path, runtime }) => path === "." && runtime === "node")
    .map(({ version }) => version);
  expect(versions).toHaveLength(2);
  const oldest = run(versions[0]);
  const newest = run(versions[1]);
  expect(oldest["builds-key"]).not.toBe(newest["builds-key"]);
  expect(oldest["tools-key"]).not.toBe(newest["tools-key"]);
  expect(oldest["tools-paths"]).not.toMatch(/toolchains[\\/](llvm|clang|gcc)/);
  expect(oldest["tools-paths"]).toContain(join(root, "workbench-ci", "cache", "toolchains", "node"));
  expect(oldest["tools-paths"]).not.toContain(join(root, "workbench-ci", "cache", "toolchains", "vcpkg"));
  expect(oldest["tools-paths"]).not.toContain(join(root, "workbench-ci", "data"));
  expect(readFileSync(environment, "utf8")).toContain(
    `UV_PYTHON_INSTALL_DIR=${join(root, "workbench-ci", "cache", "uv-python", "python")}`,
  );
  if (process.platform === "win32") {
    expect(oldest["builds-paths"]).toBe(join(root, "workbench-ci", "cache", "go-build"));
    expect(oldest["downloads-paths"]).toContain(join(root, "workbench-ci", "cache", "downloads", "uv-python"));
  } else expect(oldest["builds-paths"]).toContain(join(root, "workbench-ci", "cache", "dependencies"));
  expect(oldest["builds-paths"]).not.toMatch(/\/nix\/store|\/gnu\/store/);
  expect(oldest["builds-paths"]).not.toContain("package-managers");
  expect(oldest["downloads-key"]).toBe(newest["downloads-key"]);
  expect(oldest["downloads-paths"]).toContain(join(root, "workbench-ci", "cache", "downloads/pnpm"));
  expect(oldest["downloads-paths"]).not.toContain(join(root, "workbench-ci", "cache", "builds"));
  expect(oldest["package-managers-paths"]).toContain(join(root, "workbench-ci", "cache", "package-managers"));
  expect(oldest["package-managers-key"]).toBe(newest["package-managers-key"]);
  expect(readFileSync(environment, "utf8")).toContain("WORKBENCH_STORAGE_EXTERNAL=true");
});

test("native cache keys follow selected acquisition policy independently of bootstrap and unused assets", () => {
  const root = fixture();
  for (const path of [
    "bin",
    "bundle",
    "scripts",
    "src",
    "workbench",
    "languages",
    "collections",
    ".node-version",
    ".tool-versions",
    "package.json",
  ])
    cpSync(join(repository, path), join(root, path), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
  );
  const environment = join(root, "environment");
  const output = join(root, "output");
  const run = () => {
    writeFileSync(environment, "");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(root, "scripts/ci-cache.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify({ paths: ["."] }),
        WORKBENCH_DISTRIBUTION_ROOT: root,
        WORKBENCH_PROJECT_ROOT: root,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
  };
  const baseline = run();
  const inventoryPath = join(root, "scripts/native-assets.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  inventory.gcc["99.0.0"] = {};
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  expect(run()["tools-key"]).toBe(baseline["tools-key"]);
  const bootstrap = join(root, "src/package-manager.ts");
  writeFileSync(bootstrap, `${readFileSync(bootstrap, "utf8")}\n`);
  const changedBootstrap = run();
  expect(changedBootstrap["package-managers-key"]).not.toBe(baseline["package-managers-key"]);
  expect(changedBootstrap["tools-key"]).toBe(baseline["tools-key"]);
  expect(changedBootstrap["builds-key"]).toBe(baseline["builds-key"]);
  const acquisition = join(root, "src/artifact-streams.ts");
  writeFileSync(acquisition, `${readFileSync(acquisition, "utf8")}\n`);
  const changedInstaller = run();
  expect(changedInstaller["downloads-key"]).toBe(baseline["downloads-key"]);
  expect(changedInstaller["builds-key"]).not.toBe(baseline["builds-key"]);
  const key = join(root, "scripts/keys/node.asc");
  writeFileSync(key, `${readFileSync(key, "utf8")}\n`);
  expect(run()["tools-key"]).not.toBe(baseline["tools-key"]);
});

test("Python compatibility delegates the selected version to configured compatibility checks", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import { appendFileSync } from "node:fs"; appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "python"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["python"]', PYTHON_VERSION: "3.11.17" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events).toEqual([["compatibility-exec", "python", "python", "3.11.17", "--checks"]]);
  const workflow = parse(readFileSync(join(repository, ".github/workflows/checks.yml"), "utf8"));
  const step = workflow.jobs.compatibility.steps.find((entry) => entry.run === "node scripts/ci-run.mjs python");
  expect(step.env.CHECK_ROOTS).toContain("matrix.paths");
  expect(JSON.stringify(workflow.jobs.compatibility.steps)).not.toContain("pip install");
});

test("compiler compatibility executes ordinary, sanitizer, and optimized release checks with the same selection", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import { appendFileSync } from "node:fs"; appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "compiler"], {
    cwd: root,
    env: {
      ...process.env,
      CHECK_ROOTS: '["native"]',
      COMPILER: "gcc",
      COMPILER_VERSION: "14.4.0",
      CHECK_ROLES: '["test","sanitizers","lto"]',
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events).toEqual(
    ["test", "sanitizers", "lto"].map((role) => [
      "checks",
      "run",
      "--role",
      role,
      "--path",
      "native",
      "--environment",
      "native",
      "--compiler",
      "gcc",
      "--compiler-version",
      "14.4.0",
    ]),
  );
});

test.skipIf(process.platform !== "linux")(
  "LLVM caches contain only selected retained installations and are saved after verification",
  () => {
    const root = fixture();
    const environment = join(root, "environment");
    const output = join(root, "output");
    const keys = [];
    for (const version of ["21.1.8", "22.1.8", "23.1.3"]) {
      writeFileSync(environment, "");
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, [join(repository, "scripts/ci-cache.mjs")], {
        cwd: repository,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GITHUB_ENV: environment,
          GITHUB_OUTPUT: output,
          CACHE_TARGET: JSON.stringify({ runtime: "clang", version, paths: ["examples/languages/c"] }),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const fields = Object.fromEntries(
        [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
          (match) => [match[1], match[2]],
        ),
      );
      keys.push(fields["llvm-key"]);
      expect(fields["llvm-key"]).toMatch(/^llvm-v3-/);
      expect(fields["llvm-paths"]).toContain(join(root, "workbench-ci", "cache", "toolchains", "llvm"));
      expect(fields["llvm-paths"]).not.toContain("downloads");
      expect(fields["llvm-paths"].split("\n").filter((path) => path.includes("toolchains/llvm/"))).toHaveLength(1);
      if (version !== "23.1.3") expect(fields["clang-paths"]).toContain(join("toolchains", "clang", version));
      else expect(fields["clang-key"]).toBeUndefined();
      expect(fields["llvm-paths"]).not.toContain(join("toolchains", "clang"));
    }
    expect(new Set(keys).size).toBe(1);
    const workflow = parse(readFileSync(join(repository, ".github/workflows/checks.yml"), "utf8"));
    for (const [job, setup, check] of [
      ["native", "native-install", "native-check"],
      ["compatibility", "compiler-install", "compiler"],
    ]) {
      const steps = workflow.jobs[job].steps;
      const restore = steps.findIndex((step) => step.id === "llvm-cache");
      const install = steps.findIndex((step) => step.run === `node scripts/ci-run.mjs ${setup}`);
      const save = steps.findIndex(
        (step) => step.uses?.includes("actions/cache/save@") && step.with.key.includes("llvm-key"),
      );
      const tests = steps.findIndex((step) => step.run === `node scripts/ci-run.mjs ${check}`);
      expect(restore).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(restore);
      expect(save).toBeGreaterThan(install);
      expect(tests).toBeGreaterThan(save);
      expect(steps[save].if).toContain(`steps.${steps[install].id}.conclusion == 'success'`);
    }
  },
);

test("compatibility wrapper selects one verified runtime per root and forwards the exact version", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import {appendFileSync} from "node:fs"; appendFileSync("events.jsonl",JSON.stringify({args:process.argv.slice(2),roots:JSON.parse(process.env.CHECK_ROOTS)})+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "compatibility"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["one","two"]', RUNTIME: "go", RUNTIME_VERSION: "1.26.8" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events.map(({ roots }) => roots)).toEqual([["one"], ["two"]]);
  expect(events.map(({ args }) => args.slice(0, 4))).toEqual([
    ["compatibility-exec", "one", "go", "1.26.8"],
    ["compatibility-exec", "two", "go", "1.26.8"],
  ]);
});

test("local guest executes the shared phases, retains releases separately, and continues after target failure", () => {
  const root = fixture();
  const reports = join(root, "reports");
  mkdirSync(join(root, "bin"));
  mkdirSync(reports);
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import {appendFileSync,mkdirSync,writeFileSync} from "node:fs"; const args=process.argv.slice(2); appendFileSync("events.jsonl",JSON.stringify({args,target:process.env.WORKBENCH_CI_TARGET})+"\\n"); if(args.includes("bad")) process.exitCode=2; if(args.includes("release")){mkdirSync("dist",{recursive:true});writeFileSync("dist/package.txt","standalone");}',
  );
  mkdirSync(join(root, "scripts"));
  cpSync(join(repository, "scripts/ci-run.mjs"), join(root, "scripts/ci-run.mjs"));
  cpSync(join(repository, "scripts/ci-contract.mjs"), join(root, "scripts/ci-contract.mjs"));
  const targets = [
    { id: "bad", kind: "native", path: "bad", release: true },
    { id: "good", kind: "native", path: ".", release: true },
    {
      id: "compiler",
      kind: "compatibility",
      path: ".",
      runtime: "clang",
      version: "22.1.8",
      roles: ["test", "sanitizers", "lto"],
    },
    { id: "python", kind: "compatibility", path: ".", runtime: "python", version: "3.11.17" },
    { id: "node", kind: "compatibility", path: ".", runtime: "node", version: "22.23.3" },
  ];
  writeFileSync(join(root, "targets.json"), JSON.stringify(targets));
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-linux/run.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_DISTRIBUTION_ROOT: root,
      WORKBENCH_CI_TARGETS: join(root, "targets.json"),
      HOME: join(root, "home"),
      RUNNER_TEMP: reports,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(1);
  const results = JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")).targets;
  expect(results.map(({ success }) => success)).toEqual([false, true, true, true, true]);
  expect(existsSync(join(results[1].report, "release-artifacts/0.tar.gz"))).toBe(true);
  expect(readFileSync(join(results[1].report, "release-artifacts/0.txt"), "utf8")).toBe(".\n");
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events.filter(({ target }) => target === "bad")).toHaveLength(1);
  expect(
    events
      .filter(({ target, args }) => target === "compiler" && args.includes("--role"))
      .map(({ args }) => args[args.indexOf("--role") + 1]),
  ).toEqual(["test", "sanitizers", "lto"]);
  expect(events.find(({ target, args }) => target === "node" && args.includes("compatibility-exec")).args).toContain(
    "22.23.3",
  );
});

test("CI retains selected Rust versions and the tool versions installed inside Dev Containers", () => {
  const root = fixture();
  const run = (target) => {
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(repository, "scripts/ci-cache.mjs")], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, "environment"),
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify(target),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
  };
  const rust = run({ paths: ["examples/languages/rust"] });
  expect(rust["rust-paths"]).toContain(join(root, "workbench-ci/cache/ci/rustup/toolchains/1.99.0-*"));
  expect(rust["rust-paths"]).toContain("nightly-2026-10-04-*");
  expect(rust["rust-paths"]).not.toContain("downloads");
  const msrv = run({ paths: ["examples/languages/rust"], runtime: "rust", version: "1.93.0" });
  expect(msrv["rust-key"]).not.toBe(rust["rust-key"]);
  expect(msrv["rust-paths"]).toContain("1.93.0-*");
  expect(msrv["rust-paths"]).not.toContain("1.99.0");
  const guest = run({
    paths: ["examples/languages/cpp", "examples/languages/java", "examples/languages/python"],
    environment: "devcontainer",
  });
  expect(guest["llvm-paths"]).toContain(join(root, "workbench-ci/cache/toolchains/llvm"));
  expect(guest["tools-paths"]).not.toContain(join(root, "workbench-ci/cache/toolchains/llvm"));
  for (const tool of ["cmake", "ninja", "java", "maven", "uv"])
    expect(guest["tools-paths"]).toContain(join(root, "workbench-ci/cache/toolchains", tool));
  const pythonInstall = join(root, "workbench-ci/cache/uv-python/python");
  if (process.platform === "win32") expect(guest["tools-paths"]).not.toContain(pythonInstall);
  else expect(guest["tools-paths"]).toContain(pythonInstall);
  expect(guest["tools-paths"]).not.toMatch(/\/nix\/store|\/gnu\/store/);
});

test("cache measurement records elapsed time and counts overlapping directories once", () => {
  const root = fixture();
  const directory = join(root, "workbench-ci");
  mkdirSync(join(directory, "cache/nested"), { recursive: true });
  writeFileSync(join(directory, "cache/nested/bytes"), "12345");
  writeFileSync(
    join(directory, "cache-plan.json"),
    JSON.stringify({ "tools-paths": [join(directory, "cache"), join(directory, "cache/nested")].join("\n") }),
  );
  const run = (phase) =>
    spawnSync(process.execPath, [join(repository, "scripts/ci-cache-metrics.mjs"), phase], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary") },
    });
  expect(run("start").status).toBe(0);
  const result = run("finish");
  expect(result.status, result.stderr).toBe(0);
  const measured = JSON.parse(readFileSync(join(directory, "cache-measurement.json"), "utf8"));
  expect(measured.groups).toEqual([{ name: "tools-paths", bytes: 5 }]);
  expect(measured.elapsed_seconds).toBeGreaterThanOrEqual(0);
  expect(readFileSync(join(root, "summary"), "utf8")).toContain("| tools-paths | 5 |");
});
