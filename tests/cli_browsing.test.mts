import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";

import { setupProject } from "../src/projects.ts";
import { synchronize } from "../src/sync.ts";

interface Feedback {
  id: string;
  title: string;
  path: string;
}
const feedbackList = (text: string) => JSON.parse(text) as Feedback[];
const feedbackRecord = (text: string) => JSON.parse(text) as Feedback;
const distribution = resolve(import.meta.dirname, "..");

afterEach(() => vi.unstubAllEnvs());

interface CliFixture {
  root: string;
  temporary: string;
  run: (...args: string[]) => string;
  runAt: (cwd: string, ...args: string[]) => string;
  fail: (...args: string[]) => string;
}
async function fixture(action: (fixture: CliFixture) => void | Promise<void>) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const temporary = mkdtempSync(join(tmpdir(), "workbench-cli-"));
  const root = join(temporary, "demo");
  mkdirSync(root);
  const invokeAt = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_DATA_HOME: join(temporary, "data/workbench"),
      },
    });
  const runAt = (cwd: string, ...args: string[]) => {
    const result = invokeAt(cwd, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const run = (...args: string[]) => runAt(root, ...args);
  const fail = (...args: string[]) => {
    const result = invokeAt(root, ...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    await setupProject(root, "demo");
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    synchronize(root);
    await action({ root, temporary, run, runAt, fail });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function snapshot(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), readFileSync(path, "utf8")];
      }),
  );
}

test("pre-push executes online checks fresh, while ordinary checks remain offline", () =>
  fixture(({ root, run, fail }) => {
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      join(root, "step.cjs"),
      'require("node:fs").appendFileSync("events", process.argv[2] + "\\n"); if(process.argv[2] === "fail")process.exit(1);',
    );
    const before = readFileSync(config, "utf8");
    const check = (name: string, role: string, online = false) =>
      `\n[[check]]\nname="${name}"\nrole="${role}"\ncommand=["node","step.cjs","${name}"]\nonline=${String(online)}\n`;
    const offline = before + check("setup", "setup") + check("test", "test");
    const declared = offline + check("audit", "policy-audit", true);
    writeFileSync(config, declared);
    const plan = JSON.parse(run("pre-push", "--json")) as ReturnType<typeof import("../src/checks.ts").inspectChecks>;
    assert.equal(plan.stage, "ci");
    assert.deepEqual(
      plan.selected.map((check: { role: string }) => check.role),
      ["setup", "policy-audit"],
    );
    assert.equal(existsSync(join(root, "events")), false);
    run("pre-push");
    run("pre-push");
    assert.equal(readFileSync(join(root, "events"), "utf8"), "setup\naudit\nsetup\naudit\n");
    run("pre-commit", "--no-cache");
    assert.equal(readFileSync(join(root, "events"), "utf8"), "setup\naudit\nsetup\naudit\nsetup\ntest\n");
    writeFileSync(config, offline);
    assert.match(run("pre-push"), /No online pre-push checks are configured/);
    writeFileSync(config, offline + check("fail", "policy-audit", true));
    assert.match(fail("pre-push"), /Check gate failed/);
  }));

test("scope selection uses the deepest current project; options work on either side of actions", () =>
  fixture(({ root, run, runAt, fail }) => {
    run("project", "add", "api", "api");
    run("project", "add", "worker", "api/worker");
    mkdirSync(join(root, "api/worker/src"));
    run("record", "add", "task", "Root task");
    runAt(join(root, "api"), "record", "add", "task", "API task");
    runAt(join(root, "api/worker/src"), "record", "add", "task", "Worker task");
    assert.match(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"), /Root task/);
    assert.match(readFileSync(join(root, "api/workbench/tasks/TSK-00.md"), "utf8"), /API task/);
    assert.match(readFileSync(join(root, "api/worker/workbench/tasks/TSK-00.md"), "utf8"), /Worker task/);
    run("record", "add", "task", "Explicit scope", "--project", "api");
    assert.match(readFileSync(join(root, "api/workbench/tasks/TSK-01.md"), "utf8"), /Explicit scope/);
    assert.match(fail("record", "add", "decision", "Bad options", "--parent", "demo:TSK-0"), /only to tasks/);
    assert.match(fail("record", "add", "task", "Bad protocol", "--protocol", "unused"), /only to experiments/);
    assert.match(run("project"), /worker: api\/worker/);
    assert.deepEqual(
      (JSON.parse(run("project", "--json")) as { id: string }[]).map((project: { id: string }) => project.id).sort(),
      ["api", "demo", "worker"],
    );
    assert.match(run("language", "roots", "--project", "api"), /api:/);
  }));

test("feedback uses platform data locations and inspection does not initialize storage", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-xdg-"));
  try {
    for (const [name, xdg] of [
      ["unset", undefined],
      ["empty", ""],
      ["relative", "relative-data"],
      ["explicit", join(temporary, "custom")],
      ["override", undefined],
    ] as const) {
      const home = join(temporary, required(name, "Fixture value name"));
      const local = join(home, "windows-data");
      const override = name === "override" ? join(home, "selected") : undefined;
      const base =
        process.platform === "win32"
          ? join(local, "data")
          : process.platform === "darwin"
            ? join(home, "Library/Application Support")
            : name === "explicit"
              ? xdg
              : join(home, ".local/share");
      const folder = override
        ? join(override, "feedback")
        : process.platform === "win32"
          ? join(local, "workbench/data/feedback")
          : join(required(base, "Fixture value base"), "workbench/feedback");
      const invoke = (...args: string[]) => {
        const result = spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), "feedback", ...args], {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            LOCALAPPDATA: local,
            WORKBENCH_DATA_HOME: override,
            XDG_DATA_HOME: xdg,
            WORKBENCH_PROJECT_ROOT: distribution,
            WORKBENCH_DISTRIBUTION_ROOT: distribution,
          },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
      };
      assert.deepEqual(JSON.parse(invoke("--json")), []);
      assert.equal(existsSync(folder), false);
      invoke("add", `Feedback ${name}`);
      const entry = required(feedbackList(invoke("--json"))[0], "Feedback fixture");
      assert.equal(entry.path, join(folder, `${entry.id}.md`));
      assert.equal(entry.title, `Feedback ${name}`);
      assert.equal(existsSync(entry.path), true);
      if (process.platform !== "win32") assert.equal(statSync(folder).mode & 0o777, 0o700);
      assert.equal(existsSync(join(temporary, "relative-data")), false);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("feedback is browsable locally and resolution controls default visibility", () =>
  fixture(({ temporary, run, fail }) => {
    assert.deepEqual(JSON.parse(run("feedback", "--json")), []);
    assert.equal(existsSync(join(temporary, "data")), false);
    run("feedback", "add", "Search add parser");
    const entry = required(feedbackList(run("feedback", "--json"))[0], "Feedback fixture");
    assert.match(run("feedback", "parser"), new RegExp(entry.id));
    assert.match(run("feedback", "--", "add"), new RegExp(entry.id));
    assert.match(run("feedback", "show", entry.id), /Disposition: New/);
    assert.equal(feedbackRecord(run("feedback", "show", entry.id, "--json")).id, entry.id);
    const file = feedbackRecord(run("feedback", "show", entry.id, "--json")).path;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    assert.equal(required(feedbackList(run("feedback", "--json"))[0], "Feedback entry").id, entry.id);
    run("feedback", "resolve", entry.id, "accepted", "Promote this improvement");
    assert.deepEqual(JSON.parse(run("feedback", "--json")), []);
    assert.deepEqual(
      feedbackList(run("feedback", "--all", "--json", "--", "parser")).map((record: { id: string }) => record.id),
      [entry.id],
    );
    assert.match(fail("feedback", "show", "../other"), /decimal digits/);
  }));

test("read-only defaults and invalid write requests are explicit", () =>
  fixture(({ root, run, fail }) => {
    const path = join(root, "format-me.md");
    const original = "Long text to wrap. ".repeat(20) + "\n";
    writeFileSync(path, original);
    const formatted = run("format", path);
    assert.notEqual(formatted, original);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.match(fail("format", path, "--check"), /formatting differs/);
    assert.match(fail("format", path, "--write", "--check"), /cannot be used/);
    assert.equal(readFileSync(path, "utf8"), original);
    run("format", path, "--write");
    assert.equal(readFileSync(path, "utf8"), formatted);
    run("format", path, "--check");
    assert.match(run("sync"), /Already up to date/);
    assert.match(run("check", "--list"), /configured: none/);
    assert.match(run("language"), /typescript/);
    assert.match(run(), /Usage: workbench/);
    assert.match(run("citation", "fetch"), /No citation records/);
    assert.match(fail("citation", "fetch", "0", "--all"), /unknown option.*--all/);
    assert.match(run("citation", "fetch", "--source", "published"), /No citation sources match/);
    assert.match(fail("language", "check"), /too many arguments for .language./);
    assert.match(fail("record", "add", "experiment", "Trial"), /--protocol/);
    const before = snapshot(root);
    assert.match(fail("setup", "--id", "different"), /already registered/);
    assert.deepEqual(snapshot(root), before);
  }));

test("removed record browsing is rejected and creation preserves literal titles", () =>
  fixture(({ root, run, fail }) => {
    for (const command of ["search", "task", "decision", "experiment", "environment"])
      assert.match(fail(command, "parser"), /unknown command|too many arguments/);
    assert.match(fail("record", "show", "0"), /unknown command|too many arguments/);
    run("record", "add", "task", "--", "--help");
    assert.match(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"), /# TSK-0: --help/);
    assert.match(fail("record", "add", "task", "--typo"), /unknown option/);
  }));
