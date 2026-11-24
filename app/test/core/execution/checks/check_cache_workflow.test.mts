import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "smol-toml";
import { addRecord } from "../../../../src/core/records/records.ts";
import { synchronize } from "../../../../src/core/records/sync.ts";
import type { CheckRunResult } from "../../../../src/core/execution/checks/check-report.ts";
import { required } from "../../../../src/core/runtime/invariants.ts";
import { consumer, distribution, git } from "../../../fixtures/adoption.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
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
  write(".gitignore", "/generated.txt\n/.reports/\n");
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
          command: command("require('node:fs').copyFileSync('shared.txt', 'generated.txt')"),
        },
        {
          name: "Root tests",
          role: "test",
          input_groups: ["root"],
          command: command("require('node:assert').ok(require('node:fs').readFileSync('root.txt').length)"),
        },
        {
          name: "Whole-project check",
          role: "docs",
          command: command("require('node:assert').ok(require('node:fs').readFileSync('left/input.txt').length)"),
        },
        ...["left", "right"].map((path) => ({
          name: `${path} tests`,
          path,
          role: "test",
          input_groups: [path],
          command: command(
            "const fs=require('node:fs'), a=require('node:assert/strict'); a.ok(fs.readFileSync('input.txt').length); a.equal(fs.readFileSync('../generated.txt','utf8'),'prepared\\n')",
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
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    GITLAB_CI: undefined,
  };
  const run = (name: string) => {
    const report = join(root, ".reports", `${name}.json`);
    const result = spawnSync(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "check", "--stage", "commit", "--report", report],
      { cwd: root, encoding: "utf8", env },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return (JSON.parse(readFileSync(report, "utf8")) as { runs: CheckRunResult[] }).runs;
  };
  expect(run("initial").flatMap((entry) => entry.checks.map((check) => check.name))).toHaveLength(5);
  rmSync(join(root, "generated.txt"));
  write("left/input.txt", "second\n");
  const mixed = run("left");
  expect(mixed.filter((entry) => entry.reused).flatMap((entry) => entry.checks.map((check) => check.name))).toEqual([
    "Root tests",
    "right tests",
  ]);
  expect(mixed.filter((entry) => !entry.reused).flatMap((entry) => entry.checks.map((check) => check.name))).toEqual([
    "Prepare shared input",
    "Whole-project check",
    "left tests",
  ]);
  expect(existsSync(join(root, "generated.txt"))).toBe(true);

  write("left/input.txt", "third\n");
  git(root, "add", "left/input.txt");
  write("left/input.txt", "");
  const hook = spawnSync("bash", [join(distribution, ".githooks/pre-commit")], { cwd: root, encoding: "utf8", env });
  expect(hook.status, hook.stdout + hook.stderr).toBe(0);
  expect(hook.stderr).toContain("Reusing 2 successful checks; 3 run fresh");
});

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

test("the CLI and Git hook resolve scoped inputs from their own checkouts", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const write = (name: string, contents: string) => {
    writeFileSync(join(root, name), contents);
  };
  mkdirSync(join(root, "launcher/[fixtures]"), { recursive: true });
  mkdirSync(join(root, "other"));
  write(".gitignore", "/local-input\n/.reports/\n");
  write(
    "launcher/check.cjs",
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('../LICENSE', 'utf8'), 'allowed');
for (const name of fs.readdirSync('[fixtures]')) {
  assert.equal(fs.readFileSync('[fixtures]/' + name, 'utf8'), 'valid');
}
`,
  );
  write("local-input", "ignored input");
  write("launcher/[fixtures]/baseline.txt", "valid");
  write("LICENSE", "allowed");
  write("other/service.txt", "unrelated");
  const config = parse(readFileSync(join(root, "workbench/config.toml"), "utf8"));
  delete config.check;
  config.checks = { inputs: ["local-input"] };
  write("workbench/config.toml", stringify(config));
  const automation = {
    input_groups: {
      shared: { paths: ["LICENSE"] },
      launcher: { paths: ["launcher/[fixtures]", "launcher/check.cjs"], depends_on: ["shared"] },
      other: { paths: ["other"] },
    },
    check: [
      {
        name: "Launcher",
        role: "test",
        path: "launcher",
        input_groups: ["launcher"],
        command: [process.execPath, "check.cjs"],
      },
    ],
  };
  const save = () => {
    write("workbench/automation.toml", stringify(automation));
  };
  save();
  synchronize(root);
  git(root, "add", ".");
  git(root, "commit", "-m", "Synthetic launcher baseline");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(process.execPath), join(distribution, "bin"), process.env.PATH].join(delimiter),
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    GITLAB_CI: undefined,
  };
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "check", "--stage", "commit", ...args], {
      cwd: root,
      encoding: "utf8",
      env,
    });
  const plan = invoke("--json");
  expect(plan.status, plan.stdout + plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout)).toMatchObject({
    inputScope: {
      mode: "scoped",
      groups: ["launcher", "shared"],
      paths: expect.arrayContaining(["LICENSE", "launcher/[fixtures]", "local-input"]) as unknown,
    },
  });
  const run = (name: string, success = true) => {
    const path = join(root, ".reports", `${name}.json`);
    const result = invoke("--report", path);
    expect(result.status === 0, result.stdout + result.stderr).toBe(success);
    return (JSON.parse(readFileSync(path, "utf8")) as { runs: CheckRunResult[] }).runs[0]?.cache;
  };
  expect(run("initial")).toMatchObject({ outcome: "fresh", inputScope: { mode: "scoped" } });
  write("other/service.txt", "unrelated edit");
  write("launcher/not-declared.txt", "sibling edit");
  expect(run("unrelated")).toMatchObject({ outcome: "reused" });
  write("launcher/[fixtures]/added.txt", "valid");
  expect(run("added")).toMatchObject({ outcome: "fresh" });
  write("launcher/[fixtures]/renamed.txt", "valid");
  rmSync(join(root, "launcher/[fixtures]/added.txt"));
  expect(run("renamed")).toMatchObject({ outcome: "fresh" });
  rmSync(join(root, "launcher/[fixtures]/renamed.txt"));
  expect(run("restored")).toMatchObject({ outcome: "reused" });
  write("LICENSE", "rejected");
  expect(run("shared-change", false)).toMatchObject({ outcome: "fresh" });
  expect(run("shared-change-again", false)).toMatchObject({ outcome: "fresh" });
  write("local-input", "ignored file edited");
  write("LICENSE", "allowed");
  expect(run("additive")).toMatchObject({ outcome: "fresh" });

  // The staged tree still has its original declaration and files.
  write("local-input", "ignored input");
  git(root, "add", "-f", "local-input");
  write("local-input", "ignored file edited");
  const launcher = required(automation.check[0], "launcher");
  launcher.input_groups = [];
  save();
  write("LICENSE", "rejected");
  expect(run("incomplete", false)).toMatchObject({
    outcome: "fresh",
    inputScope: { mode: "whole-project", reason: "No input groups for Launcher" },
  });
  const hook = spawnSync("bash", [join(distribution, ".githooks/pre-commit")], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  expect(hook.status, hook.stdout + hook.stderr).toBe(0);
  expect(hook.stderr).toContain("Reused successful gate");
});
