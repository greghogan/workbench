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
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

function fixture(action) {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-cli-"));
  const root = join(temporary, "demo");
  mkdirSync(root);
  const invokeAt = (cwd, ...args) =>
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
  const runAt = (cwd, ...args) => {
    const result = invokeAt(cwd, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const run = (...args) => runAt(root, ...args);
  const fail = (...args) => {
    const result = invokeAt(root, ...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    run("setup-project", root);
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run("sync");
    action({ root, temporary, run, runAt, fail });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function snapshot(root) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), readFileSync(path, "utf8")];
      }),
  );
}

const references = (output) =>
  JSON.parse(output)
    .map((record) => record.reference)
    .sort();

test("direct browsing searches literal text and all types without mutating project files", () =>
  fixture(({ root, run, fail }) => {
    run("task", "add", "Parser add --help-all");
    const task = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(task, readFileSync(task, "utf8") + "\nParser result explained in the body.\n");
    run("decision", "add", "Parser policy");
    for (const [name, verb] of [
      ["environment", "add"],
      ["citation", "draft"],
    ])
      run(name, verb, "Parser evidence");
    // Nonmatching records make an unfiltered implementation fail the search assertions.
    run("task", "add", "Deployment");
    run("decision", "add", "Deployment policy");
    const before = snapshot(root);
    assert.match(run("task"), /demo:TSK-0: Parser/);
    assert.equal(run("task", "parser"), run("task", "--", "PARSER"));
    assert.match(run("task", "Parser", "result"), /demo:TSK-0/);
    assert.doesNotMatch(run("task", "parser"), /result explained/);
    assert.match(run("task", "parser", "--matches"), /\d+: Parser result explained/);
    assert.deepEqual(references(run("task", "--json", "--", "add")), ["demo:TSK-0"]);
    assert.match(run("task", "--", "--help-all"), /demo:TSK-0/);
    assert.match(run("task", "show", "tsk-00"), /Parser result explained/);
    assert.equal(JSON.parse(run("task", "show", "0", "--json")).reference, "demo:TSK-0");
    for (const [name, type] of [
      ["task", "TSK"],
      ["decision", "ADR"],
      ["environment", "ENV"],
      ["citation", "CIT"],
    ]) {
      assert.deepEqual(references(run(name, "parser", "--json")), [`demo:${type}-0`]);
    }
    for (const name of ["experiment", "release"]) assert.deepEqual(JSON.parse(run(name, "--json")), []);
    assert.deepEqual(references(run("search", "parser", "--json")), [
      "demo:ADR-0",
      "demo:CIT-0",
      "demo:ENV-0",
      "demo:TSK-0",
    ]);
    assert.deepEqual(references(run("search", "parser", "--type", "decision", "--json")), ["demo:ADR-0"]);
    assert.match(fail("task", "--status", "typo"), /invalid status/);
    assert.match(fail("task", "show", "demo:ADR-0"), /expected a TSK/);
    assert.match(fail("task", "add"), /missing required argument/);
    assert.match(fail("task", "add", "Invalid parent", "--parent", "demo:TSK-Z"), /task not found/);
    assert.match(fail("task", "add", "Invalid dependency", "--depends-on", "demo:ADR-0"), /expected a task/);
    assert.match(fail("task", "show", "Z"), /record not found/);
    assert.match(fail("task", "--json", "add", "Ignored flag"), /--json does not apply/);
    assert.match(fail("--help-all", "task"), /--help-all does not apply/);
    for (const name of ["task", "decision", "experiment", "environment", "citation", "release"]) {
      assert.deepEqual(
        JSON.parse(run(name, "--json", "--", "add")),
        JSON.parse(run("search", "add", "--type", name, "--json")),
      );
    }
    assert.deepEqual(snapshot(root), before);
  }));

test("scope selection uses the deepest current project; options work on either side of actions", () =>
  fixture(({ root, run, runAt, fail }) => {
    run("project", "add", "api", "api");
    run("project", "add", "worker", "api/worker");
    mkdirSync(join(root, "api/worker/src"));
    run("task", "add", "Root task");
    runAt(join(root, "api"), "task", "add", "API task");
    runAt(join(root, "api/worker/src"), "task", "add", "Worker task");
    assert.deepEqual(references(run("task", "--json")), ["api:TSK-0", "demo:TSK-0", "worker:TSK-0"]);
    assert.match(runAt(join(root, "api/worker/src"), "task", "show", "0"), /Worker task/);
    assert.match(runAt(join(root, "api"), "task", "show", "0"), /API task/);
    assert.match(run("task", "--project", "api", "show", "0"), /API task/);
    assert.match(run("task", "show", "0", "--project", "api"), /API task/);
    assert.deepEqual(references(run("task", "--project", "api", "--json", "--", "task")), ["api:TSK-0"]);
    assert.match(fail("task", "show", "demo:TSK-0", "--project", "api"), /conflicts with --project/);
    assert.match(fail("task", "--project", "api", "show", "0", "--project", "worker"), /conflicting values/);
    assert.match(run("project"), /worker: api\/worker/);
    assert.deepEqual(
      JSON.parse(run("project", "--json"))
        .map((project) => project.id)
        .sort(),
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
    ]) {
      const home = join(temporary, name);
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
          : join(base, "workbench/feedback");
      const invoke = (...args) => {
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
      const [entry] = JSON.parse(invoke("--json"));
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
    const [entry] = JSON.parse(run("feedback", "--json"));
    assert.match(run("feedback", "parser"), new RegExp(entry.id));
    assert.match(run("feedback", "--", "add"), new RegExp(entry.id));
    assert.match(run("feedback", "show", entry.id), /Disposition: New/);
    assert.equal(JSON.parse(run("feedback", "show", entry.id, "--json")).id, entry.id);
    const file = JSON.parse(run("feedback", "show", entry.id, "--json")).path;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    assert.equal(JSON.parse(run("feedback", "--json"))[0].id, entry.id);
    run("feedback", "resolve", entry.id, "accepted", "Promote this improvement");
    assert.deepEqual(JSON.parse(run("feedback", "--json")), []);
    assert.deepEqual(
      JSON.parse(run("feedback", "--all", "--json", "--", "parser")).map((record) => record.id),
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
    assert.match(run("checks"), /configured: none/);
    assert.match(run("language"), /typescript/);
    assert.match(run(), /Usage: workbench/);
    assert.match(fail("citation", "fetch"), /one citation ID or --all/);
    assert.match(fail("citation", "fetch", "0", "--all"), /one citation ID or --all/);
    assert.match(fail("citation", "fetch", "--all", "--source", "published"), /single citation ID/);
    assert.match(fail("language", "check", "typescript", "--all"), /one language or --all/);
    assert.match(fail("experiment", "add", "Trial"), /--protocol/);
    const before = snapshot(root);
    assert.match(fail("setup", "--id", "different"), /already registered/);
    assert.deepEqual(snapshot(root), before);
  }));

test("literal query boundaries distinguish options, action arguments, and search text", () =>
  fixture(({ root, run, fail }) => {
    run("task", "add", "add parser --all search");
    run("task", "add", "--", "--help");
    run("task", "add", "show 0");
    const task = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(task, readFileSync(task, "utf8").replace("status: Planned", "status: Done"));
    const before = snapshot(root);
    assert.deepEqual(JSON.parse(run("task", "--json", "--", "add")), []);
    assert.deepEqual(references(run("task", "--all", "--json", "--", "add")), ["demo:TSK-0"]);
    assert.match(run("task", "--all", "--", "add", "parser", "--all"), /demo:TSK-0/);
    assert.match(run("task", "--project=demo", "--status", "done", "--", "add"), /demo:TSK-0/);
    assert.match(run("task", "--", "--help"), /demo:TSK-1/);
    assert.match(run("task", "--", "show", "0"), /demo:TSK-2/);
    assert.match(run("task", "--all", "search"), /demo:TSK-0/);
    assert.match(run("task", "--help", "--", "add"), /Usage:/);
    assert.equal(run("task", "--"), run("task"));
    assert.match(fail("task", "--typo", "--", "add"), /unknown option/);
    assert.match(fail("task", "--project"), /argument missing/);
    // Here -- is the project option's value, not a separator.
    assert.match(fail("task", "--project", "--", "add", "Title"), /unknown project/);
    assert.match(fail("task", "--status=--", "--", "add"), /invalid status/);
    assert.deepEqual(snapshot(root), before);
  }));
