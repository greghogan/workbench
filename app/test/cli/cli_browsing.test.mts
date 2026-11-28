import assert from "node:assert/strict";
import { fixture, snapshot } from "../fixtures/cli-browsing.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { addProject } from "../../src/cli/project-setup.js";
import { formatFiles } from "../../src/core/records/formatting.ts";
import { requiredExperimentProtocol } from "../../src/core/records/record-content.ts";

test("scope selection uses the deepest current project; options work on either side of actions", () =>
  fixture(async ({ root, run, runAt, fail }) => {
    await addProject(root, "api", "api");
    await addProject(root, "worker", "api/worker");
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
    assert.match(run("subproject"), /worker: api\/worker/);
    assert.deepEqual(
      (JSON.parse(run("subproject", "--json")) as { id: string }[]).map((project: { id: string }) => project.id).sort(),
      ["api", "demo", "worker"],
    );
    assert.match(run("language", "roots", "--project", "api"), /api:/);
  }));

test("task, queue, and experiment actions honor shared options without changing a different scope", () =>
  fixture(async ({ root, run, runAt, fail }) => {
    await addProject(root, "api", "api");
    for (const path of [".", "api"]) {
      const base = join(root, path, "workbench");
      mkdirSync(join(base, "tasks"), { recursive: true });
      writeFileSync(
        join(base, "tasks/TSK-00.md"),
        `---\nstatus: Approved\n---\n\n# TSK-0: ${path} task\n\n## Overview\n\nDeliver useful behavior.\n`,
      );
      mkdirSync(join(base, "experiments"), { recursive: true });
      writeFileSync(
        join(base, "experiments/EXP-00.md"),
        `---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: ${path} experiment\n\n` +
          requiredExperimentProtocol.map((heading) => `## ${heading}\n\nDeclared protocol.\n`).join("\n"),
      );
    }
    const show = (args: string[]) => JSON.parse(run(...args)) as { reference: string; status?: string };
    for (const args of [
      ["task", "--project", "api", "--json", "show", "TSK-0"],
      ["task", "show", "TSK-0", "--project", "api", "--json"],
    ]) {
      const task = show(args);
      assert.deepEqual(
        { reference: task.reference, status: task.status },
        { reference: "api:TSK-0", status: "Approved" },
      );
    }
    const queue = JSON.parse(run("queue", "--project", "api", "--json", "add", "TSK-0")) as {
      entries: { reference: string }[];
    };
    assert.deepEqual(
      queue.entries.map((entry) => entry.reference),
      ["api:TSK-0"],
    );
    run("queue", "start", "TSK-0", "--project", "api", "--json");
    assert.deepEqual(JSON.parse(run("task", "replan", "TSK-0", "--project", "api", "--json")), {
      reference: "api:TSK-0",
      status: "Planned",
    });
    assert.match(readFileSync(join(root, "api/workbench/tasks/TSK-00.md"), "utf8"), /status: Planned/);
    assert.match(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"), /status: Approved/);
    for (const args of [
      ["experiment", "--project", "api", "--json", "show", "EXP-0"],
      ["experiment", "show", "EXP-0", "--project", "api", "--json"],
    ])
      assert.equal(show(args).reference, "api:EXP-0");
    assert.equal(
      (JSON.parse(runAt(join(root, "api"), "experiment", "show", "EXP-0", "--json")) as { reference: string })
        .reference,
      "api:EXP-0",
    );
    run("experiment", "--project", "api", "start", "EXP-0");
    assert.match(readFileSync(join(root, "api/workbench/experiments/EXP-00.md"), "utf8"), /status: Running/);
    assert.match(readFileSync(join(root, "workbench/experiments/EXP-00.md"), "utf8"), /status: Planned/);
    run("experiment", "replan", "EXP-0", "--project", "api");
    assert.match(fail("experiment", "--project", "missing", "--json"), /unknown project/);
    assert.match(fail("task", "--all", "show", "TSK-0"), /--all does not apply/);
    assert.match(fail("experiment", "--json", "start", "EXP-0"), /--json does not apply/);
  }));

test("read-only defaults and invalid write requests are explicit", () =>
  fixture(async ({ root, run, fail }) => {
    const path = join(root, "format-me.md");
    const original = "Long text to wrap. ".repeat(20) + "\n";
    writeFileSync(path, original);
    const formatted = run("format", path);
    assert.notEqual(formatted, original);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.match(fail("format", path, "--check"), /formatting\s+differs/);
    assert.match(fail("format", path, "--write", "--check"), /cannot be used/);
    assert.equal(readFileSync(path, "utf8"), original);
    run("format", path, "--write");
    assert.equal(readFileSync(path, "utf8"), formatted);
    await formatFiles(root, path, { check: true });
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
    assert.match(fail("init", "--id", "different"), /already registered/);
    assert.deepEqual(snapshot(root), before);
  }));

test("record creation preserves literal titles and rejects malformed requests", () =>
  fixture(({ root, run, fail }) => {
    run("record", "add", "task", "--", "--help");
    assert.match(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"), /# TSK-0: --help/);
    assert.match(fail("record", "add", "task", "--typo"), /unknown option/);
  }));
