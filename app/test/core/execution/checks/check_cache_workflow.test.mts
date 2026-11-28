import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "smol-toml";
import { addRecord } from "../../../../src/core/records/records.ts";
import { synchronize } from "../../../../src/core/records/sync.ts";
import { nativeCheckBackend } from "../../../../src/core/execution/checks/check-isolation.ts";
import { runChecks } from "../../../../src/core/execution/checks/checks.ts";
import { withExecutionEnvironment } from "../../../../src/core/execution/environments/execution-context.ts";
import type { CheckRunResult } from "../../../../src/core/execution/checks/check-report.ts";
import { required } from "../../../../src/core/runtime/invariants.ts";
import { buildPaths } from "../../../../src/core/artifacts/builds.ts";
import { consumer, distribution, git } from "../../../fixtures/adoption.mjs";

const temporary: string[] = [];
const scopedExecution = !!nativeCheckBackend();
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("a source change during a fresh security scan fails the gate with and without reused results", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const write = (name: string, contents: string) => {
    writeFileSync(join(root, name), contents);
  };
  write(".gitignore", "/.reports/\n/root-*.json\n");
  write("tested.txt", "test input\n");
  write("outside.txt", "scan input\n");
  const path = "workbench/config.toml";
  const config = parse(readFileSync(join(root, path), "utf8"));
  delete config.check;
  write(path, stringify(config));
  write(
    "workbench/automation.toml",
    stringify({
      input_groups: { tested: { paths: ["tested.txt"] } },
      check: [
        {
          name: "Scoped test",
          role: "test",
          input_groups: ["tested"],
          command: [process.execPath, "-e", "require('node:fs').readFileSync('tested.txt')"],
        },
        {
          name: "Whole-project security scan",
          role: "secret",
          command: [
            process.execPath,
            "-e",
            "const fs=require('node:fs'); if(fs.existsSync('.reports/change')) fs.appendFileSync('outside.txt','changed\\n')",
          ],
        },
      ],
    }),
  );
  synchronize(root);
  git(root, "add", ".");
  git(root, "commit", "-m", "Exercise source stability");
  mkdirSync(join(root, ".reports"));
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), join(distribution, "bin"), process.env.PATH].join(delimiter),
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    GITLAB_CI: undefined,
  };
  const run = (name: string, ...flags: string[]) => {
    const path = name.startsWith("root-") ? join(root, name + ".json") : join(root, ".reports", name + ".json");
    const command = [join(distribution, "bin/workbench.mjs"), "check", "--stage", "commit", "--report", path];
    const result = spawnSync(process.execPath, [...command, ...flags], { cwd: root, encoding: "utf8", env });
    const report = JSON.parse(readFileSync(path, "utf8")) as {
      success: boolean;
      error?: string;
      runs: CheckRunResult[];
    };
    return { ...report, status: result.status, output: result.stdout + result.stderr };
  };
  write(".reports/change", "");
  const cold = run("cold");
  expect(cold, cold.output).toMatchObject({ status: 1, success: false });
  expect(cold.error).toContain("source changed during the security scan");
  await expect(
    withExecutionEnvironment(env, () =>
      runChecks(root, { stage: "commit", environment: "native", offline: true, cache: false }),
    ),
  ).rejects.toThrow("source changed during the security scan");
  rmSync(join(root, ".reports/change"));
  const stable = run("stable");
  expect(stable.status, stable.output).toBe(0);
  if (scopedExecution) {
    const inCheckout = run("root-export");
    expect(inCheckout.status, inCheckout.output).toBe(0);
    expect(inCheckout.runs.some((report) => report.reused)).toBe(true);
  }
  write(".reports/change", "");
  const mixed = run("mixed");
  expect(mixed, mixed.output).toMatchObject({ status: 1, success: false });
  expect(mixed.error).toContain("source changed during the security scan");
  if (scopedExecution) expect(mixed.runs.some((report) => report.reused)).toBe(true);
});

test("a full gate reuses independent checks and rebuilds setup needed by a fresh group", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const write = (name: string, contents: string) => {
    writeFileSync(join(root, name), contents);
  };
  for (const path of ["left", "right"]) {
    mkdirSync(join(root, path));
    write(`${path}/input.txt`, "first\n");
  }
  write(".gitignore", "build/\n/.reports/\n");
  write("shared.txt", "prepared\n");
  write("root.txt", "root checks\n");
  const configPath = join(root, "workbench/config.toml");
  const config = parse(readFileSync(configPath, "utf8"));
  delete config.check;
  write("workbench/config.toml", stringify(config));
  const command = (code: string) => [process.execPath, "-e", code];
  write(
    "workbench/automation.toml",
    stringify({
      input_groups: {
        setup: { paths: ["shared.txt"] },
        root: { paths: ["root.txt"] },
        left: { paths: ["left"] },
        right: { paths: ["right"] },
      },
      check_order: ["left", "right"].map((path) => ({ root: path, after: ".", phase: "setup" })),
      check: [
        {
          name: "Prepare shared input",
          role: "setup",
          input_groups: ["setup"],
          command: command(
            "require('node:fs').copyFileSync('shared.txt', require('node:path').join(process.env.WORKBENCH_BUILD_DIR, 'generated.txt'))",
          ),
        },
        {
          name: "Root tests",
          role: "test",
          parallel: true,
          input_groups: ["root"],
          command: command(
            "const assert = require('node:assert/strict'); assert.equal(process.env.WORKBENCH_CPU_BUDGET, '2'); assert.ok(require('node:fs').readFileSync('root.txt').length)",
          ),
        },
        {
          name: "Whole-project check",
          role: "docs",
          parallel: true,
          command: command(
            "const assert = require('node:assert/strict'); assert.equal(process.env.WORKBENCH_CPU_BUDGET, '2'); assert.ok(require('node:fs').readFileSync('left/input.txt').length)",
          ),
        },
        ...["left", "right"].map((path) => ({
          name: `${path} tests`,
          path,
          role: "test",
          input_groups: [path],
          command: command(
            scopedExecution
              ? "const fs=require('node:fs'), a=require('node:assert/strict'); a.ok(fs.readFileSync('input.txt').length); a.equal(fs.readFileSync(require('node:path').join(process.env.WORKBENCH_BUILD_DIR, 'generated.txt'),'utf8'),'prepared\\n')"
              : "require('node:assert/strict').ok(require('node:fs').readFileSync('input.txt').length)",
          ),
        })),
      ],
    }),
  );
  synchronize(root);
  git(root, "add", ".");
  git(root, "commit", "-m", "Synthetic check groups");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(process.execPath), join(distribution, "bin"), process.env.PATH].join(delimiter),
    WORKBENCH_CPUS: "2",
    WORKBENCH_CPU_BUDGET: "2",
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    GITLAB_CI: undefined,
  };
  const output = new Map<string, string>();
  const run = (name: string) => {
    const report = join(root, ".reports", `${name}.json`);
    const result = spawnSync(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "check", "--stage", "commit", "--report", report],
      { cwd: root, encoding: "utf8", env },
    );
    output.set(name, result.stdout + result.stderr);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return (JSON.parse(readFileSync(report, "utf8")) as { runs: CheckRunResult[] }).runs;
  };
  expect(run("initial").flatMap((entry) => entry.checks.map((check) => check.name))).toHaveLength(5);
  write("left/input.txt", "second\n");
  const mixed = run("left");
  expect(
    mixed.filter((entry) => entry.reused).flatMap((entry) => entry.checks.map((check) => check.name)),
    [...output.values()].join("\n"),
  ).toEqual(scopedExecution ? ["Root tests", "right tests"] : []);
  expect(mixed.filter((entry) => !entry.reused).flatMap((entry) => entry.checks.map((check) => check.name))).toEqual([
    "Prepare shared input",
    ...(scopedExecution ? [] : ["Root tests"]),
    "Whole-project check",
    "left tests",
    ...(scopedExecution ? [] : ["right tests"]),
  ]);

  write("left/input.txt", "third\n");
  git(root, "add", "left/input.txt");
  write("left/input.txt", "");
  const hook = spawnSync("bash", [join(distribution, ".githooks/pre-commit")], { cwd: root, encoding: "utf8", env });
  expect(hook.status, hook.stdout + hook.stderr).toBe(0);
  if (scopedExecution) expect(hook.stderr).toContain("Reusing 2 successful checks; 3 run fresh");
});

test.runIf(scopedExecution)(
  "a fresh test receives verified read-only build products and rebuilds damaged products",
  async () => {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
    const root = await consumer();
    temporary.push(root);
    const write = (name: string, value: string) => {
      writeFileSync(join(root, name), value);
    };
    const config = parse(readFileSync(join(root, "workbench/config.toml"), "utf8"));
    delete config.check;
    write("workbench/config.toml", stringify(config));
    write(".gitignore", "product/\n");
    write(
      "build.cjs",
      `const fs = require("node:fs");
fs.copyFileSync("source.txt", "product/program");
console.log("BUILT PROGRAM");
`,
    );
    write(
      "test.cjs",
      `const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.equal(fs.readFileSync("product/program", "utf8"), fs.readFileSync("expected.txt", "utf8"));
assert.throws(() => fs.writeFileSync("product/program", "mutated"));
assert.throws(() => fs.readFileSync("source.txt"));
`,
    );
    write("source.txt", "first\n");
    write("expected.txt", "first\n");
    write(
      "workbench/automation.toml",
      stringify({
        input_groups: {
          compilation: { paths: ["build.cjs", "source.txt"], outputs: ["product"] },
          verification: { paths: ["test.cjs", "expected.txt"] },
        },
        check: [
          {
            name: "Verify product",
            role: "test",
            requires_build: ["Build product"],
            input_groups: ["verification"],
            command: [process.execPath, "test.cjs"],
          },
          {
            name: "Build product",
            role: "build",
            stages: [],
            input_groups: ["compilation"],
            command: [process.execPath, "build.cjs"],
          },
        ],
      }),
    );
    synchronize(root);
    git(root, "add", ".");
    git(root, "commit", "-m", "Synthetic build products");
    const env = {
      ...process.env,
      PATH: [dirname(process.execPath), join(distribution, "bin"), process.env.PATH].join(delimiter),
      CI: undefined,
      GITHUB_ACTIONS: undefined,
      GITLAB_CI: undefined,
    };
    function gate() {
      const result = spawnSync(
        process.execPath,
        [join(distribution, "bin/workbench.mjs"), "check", "--stage", "commit", "--verbose"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 20000,
          env,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout + result.stderr;
    }
    expect(gate()).toContain("BUILT PROGRAM");
    write("test.cjs", readFileSync(join(root, "test.cjs"), "utf8") + "// Fresh verification.\n");
    expect(gate()).toContain("Reused verified outputs from Build product.");
    const directory = join(buildPaths(root, root, "native").directory, ".workbench-check-products");
    const [entry] = readdirSync(directory);
    writeFileSync(join(directory, required(entry, "retained build"), "0/program"), "damaged\n");
    write("test.cjs", readFileSync(join(root, "test.cjs"), "utf8") + "// Verify repaired output.\n");
    expect(gate()).toContain("BUILT PROGRAM");
    write("source.txt", "second\n");
    write("expected.txt", "second\n");
    expect(gate()).toContain("BUILT PROGRAM");
  },
);

test("cached CLI checks validate changed records and scan sidecars without rerunning behavioral tests", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const config = join(root, "workbench/config.toml");
  const options = parse(readFileSync(config, "utf8"));
  const counter = (name: string, prepare = "") => [
    process.execPath,
    "-e",
    `${prepare}require('node:fs').appendFileSync('${name}', 'x')`,
  ];
  options.check = [
    { name: "Setup", role: "setup", command: counter("setup-counter") },
    {
      name: "Tests",
      role: "test",
      command: counter("test-counter", "require('node:fs').writeFileSync('built-output', 'application');"),
    },
    {
      name: "Docs",
      role: "docs",
      command: counter("docs-counter", "require('node:fs').readFileSync('built-output');"),
    },
    {
      name: "Secrets",
      role: "secret",
      command: [process.execPath, join(distribution, "bin/workbench.mjs"), "secrets", root],
    },
  ];
  writeFileSync(config, stringify(options));
  writeFileSync(join(root, ".gitignore"), "*-counter\n/built-output\n/.reports/\n");
  synchronize(root);
  git(root, "add", ".");
  const run = (command: "check" | "pre-commit", ...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        join(distribution, "bin/workbench.mjs"),
        command,
        root,
        ...(command === "check" ? ["--stage", "commit"] : []),
        "--verbose",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined },
      },
    );
  const reportPath = (name: string) => join(root, ".reports", `${name}.json`);
  const report = (name: string) =>
    JSON.parse(readFileSync(reportPath(name), "utf8")) as {
      success: boolean;
      phases: { name: string; status: string }[];
      runs: CheckRunResult[];
    };
  const first = run("check", "--report", reportPath("first"));
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  rmSync(join(root, "built-output"));
  const record = await addRecord(root, "TSK", "Follow up");
  synchronize(root);
  const second = run("check", "--report", reportPath("second"));
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(second.stderr, first.stdout + first.stderr).toContain("Reused 2/4 checks");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  expect(readFileSync(join(root, "docs-counter"), "utf8")).toBe("x");
  expect(report("first").runs[0]?.reused).toBeUndefined();
  for (const name of ["first", "second"])
    expect(report(name).phases.filter((phase) => phase.name === "Structural validation")).toEqual([
      expect.objectContaining({ status: "passed" }),
    ]);
  const reused = required(report("second").runs[0], "reused report"),
    refreshed = required(report("second").runs[1], "fresh security report");
  expect(reused.reused).toBeDefined();
  expect(reused.checks.map(({ role }) => role)).toEqual(["test", "docs"]);
  expect(reused.checks[0]).toEqual(report("first").runs[0]?.checks.find(({ role }) => role === "test"));
  expect(refreshed.reused).toBeUndefined();
  expect(refreshed.checks.map(({ role }) => role)).toEqual(["setup", "secret"]);
  const ordinary = run("pre-commit");
  expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  const original = readFileSync(record, "utf8");
  writeFileSync(record, original.replace("status: Planned", "status: Invalid"));
  const invalid = run("pre-commit");
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).toContain("validation failed");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  writeFileSync(record, original);
  const supporting = record.slice(0, -3);
  mkdirSync(supporting);
  writeFileSync(join(supporting, "private.txt"), "-----BEGIN PRIVATE" + " KEY-----\n");
  const secret = run("check", "--report", reportPath("secret"));
  expect(secret.status).not.toBe(0);
  expect(secret.stdout + secret.stderr).toContain("possible credentials");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  expect(report("secret").success).toBe(false);
  expect(report("secret").runs.map(({ status }) => status)).toEqual(["passed", "failed"]);
});
