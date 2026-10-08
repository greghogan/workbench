import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";

const distribution = resolve(import.meta.dirname, "..");
const charter = join(distribution, "workbench/CHARTER.md");

test("Markdown formatting preserves skill metadata values", () =>
  fixture(({ root, run }) => {
    const metadata = "---\nname: example-skill\ndescription: " + "A long skill description. ".repeat(8) + "\n---\n";
    const path = join(root, "SKILL.md");
    writeFileSync(path, metadata + "\n# Example\n\n" + "A body sentence. ".repeat(12) + "\n");
    run("format", path, "--write");
    assert.deepEqual(parse(readFileSync(path, "utf8").split("---")[1]), parse(metadata.split("---")[1]));
    const once = readFileSync(path, "utf8");
    run("format", path, "--write");
    assert.equal(readFileSync(path, "utf8"), once);
  }));

function fixture(action) {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-context-"));
  const root = join(temporary, "demo");
  mkdirSync(root);
  const invoke = (...args) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    });
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const fail = (...args) => {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    run("setup-project", root);
    copyFileSync(charter, join(root, "workbench/CHARTER.md"));
    run("sync");
    action({ root, run, fail });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("root context embeds charters and scopes draft instructions and overrides", () =>
  fixture(({ root, run, fail }) => {
    cpSync(join(distribution, "workbench"), join(root, ".workbench/workbench"), { recursive: true });
    for (const [id, path] of [
      ["service", "service"],
      ["worker", "service/worker"],
      ["web", "web"],
    ]) {
      run("project", "add", id, path);
      copyFileSync(charter, join(root, path, "workbench/CHARTER.md"));
    }
    run("decision", "add", "Global retries");
    writeFileSync(
      join(root, "workbench/decisions/ADR-00.md"),
      "---\nsummary: Retry ordinary requests twice.\nagent_instruction: Retry ordinary requests twice.\n---\n\n# ADR-0: Global retries\n",
    );
    run("decision", "add", "Service retries", "--project", "service");
    const local = join(root, "service/workbench/decisions/ADR-00.md");
    const decision =
      "---\nsummary: Retry service requests once.\nagent_instruction: Retry service requests once.\n" +
      "overrides:\n  - demo:ADR-0\n---\n\n# ADR-0: Service retries\n\nThe service has its own retry budget.\n";
    writeFileSync(local, decision);
    run("sync");
    run("format", "--all", "--write");
    run("validate");
    const context = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.equal(context.split(readFileSync(charter, "utf8").trimEnd()).length - 1, 4);
    assert.match(context, /## service\n\nApplies to: `service\/` and descendants/);
    assert.match(context, /## worker\n\nApplies to: `service\/worker\/` and descendants/);
    const serviceContext = context.split("## service\n")[1].split("## worker\n")[0];
    assert.match(serviceContext, /Retry service requests once/);
    assert.match(serviceContext, /Overrides in this scope: \[demo:ADR-0\]/);
    assert.doesNotMatch(context.split("## web\n")[1], /Retry service/);
    assert.match(context, /\.workbench\/workbench\/decision-map.md/);
    assert.match(readFileSync(join(root, "service/workbench/decision-map.md"), "utf8"), /Service retries/);
    assert.equal(existsSync(join(root, "service/AGENTS.md")), false);

    run("decision", "add", "Web policy", "--project", "web");
    writeFileSync(local, decision.replace("demo:ADR-0", "web:ADR-0"));
    assert.match(fail("sync"), /outside the same or an inherited scope/);
    writeFileSync(local, decision.replace("demo:ADR-0", "service:ADR-0"));
    assert.match(fail("sync"), /override cycle/);
    writeFileSync(local, decision.replace("demo:ADR-0", "demo:ADR-Z"));
    assert.match(fail("sync"), /overridden ADR not found/);
  }));

test("record queries retain completed tasks and allocation never reuses a removed draft", () =>
  fixture(({ root, run }) => {
    run("task", "add", "Parser outcome");
    const first = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(
      first,
      readFileSync(first, "utf8").replace("status: Planned", "status: Done") + "\nEvidence: abc123\n",
    );
    run("task", "add", "Parser follow-up");
    assert.deepEqual(
      JSON.parse(run("task", "--json")).map((record) => record.reference),
      ["demo:TSK-1"],
    );
    assert.deepEqual(
      JSON.parse(run("search", "PARSER", "--all", "--json")).map((record) => record.reference),
      ["demo:TSK-0", "demo:TSK-1"],
    );
    assert.deepEqual(JSON.parse(run("search", "abc123", "--json")), []);
    assert.deepEqual(
      JSON.parse(run("search", "abc123", "--status", "done", "--json")).map((record) => record.reference),
      ["demo:TSK-0"],
    );
    assert.doesNotMatch(readFileSync(join(root, "workbench/task-map.md"), "utf8"), /Parser outcome/);
    rmSync(join(root, "workbench/tasks/TSK-01.md"));
    run("task", "add", "New draft");
    assert.ok(existsSync(join(root, "workbench/tasks/TSK-02.md")));
    run("decision", "add", "Parser policy");
    assert.match(run("search", "Parser", "--type", "ADR"), /demo:ADR-0/);
    run("format", "--all", "--write");
    run("validate");
  }));

test("complete checks reject missing structure and implicit empty configuration", () =>
  fixture(({ root, run, fail }) => {
    assert.match(fail("checks", "run"), /no configured check commands/);
    assert.match(run("checks"), /configured: none/);
    const path = join(root, "workbench/config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    assert.match(run("checks", "run"), /structural checks only/);
    assert.match(fail("checks", "run", "--role", "test"), /no configured checks have role/);
    rmSync(join(root, "workbench/CHARTER.md"));
    assert.match(fail("checks", "run"), /required file is missing/);
  }));
