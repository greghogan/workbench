import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import { parse } from "yaml";

import { setupProject } from "../src/projects.ts";
import { synchronize } from "../src/sync.ts";

const distribution = resolve(import.meta.dirname, "..");
const charter = resolve(import.meta.dirname, "fixtures/records/CHARTER.md");

test("Markdown formatting preserves skill metadata values", () =>
  fixture(({ root, run }) => {
    const metadata = "---\nname: example-skill\ndescription: " + "A long skill description. ".repeat(8) + "\n---\n";
    const path = join(root, "SKILL.md");
    writeFileSync(path, metadata + "\n# Example\n\n" + "A body sentence. ".repeat(12) + "\n");
    run("format", path, "--write");
    assert.deepEqual(
      parse(
        required(
          readFileSync(path, "utf8").split("---")[1],
          'Fixture value readFileSync(path, "utf8").split("---")[1]',
        ),
      ),
      parse(required(metadata.split("---")[1], 'Fixture value metadata.split("---")[1]')),
    );
    const once = readFileSync(path, "utf8");
    run("format", path, "--write");
    assert.equal(readFileSync(path, "utf8"), once);
  }));

afterEach(() => vi.unstubAllEnvs());

interface ContextFixture {
  root: string;
  run: (...args: string[]) => string;
  fail: (...args: string[]) => string;
}
async function fixture(action: (fixture: ContextFixture) => void | Promise<void>) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const temporary = mkdtempSync(join(tmpdir(), "workbench-context-"));
  const root = join(temporary, "demo");
  mkdirSync(root);
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    });
  const run = (...args: string[]) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const fail = (...args: string[]) => {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    await setupProject(root, "demo");
    copyFileSync(charter, join(root, "workbench/CHARTER.md"));
    synchronize(root);
    await action({ root, run, fail });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("root context embeds charters and scopes draft instructions without overrides", () =>
  fixture(({ root, run, fail }) => {
    for (const [id, path] of [
      ["service", "service"],
      ["worker", "service/worker"],
      ["web", "web"],
    ] as const) {
      run("project", "add", id, path);
      copyFileSync(charter, join(root, required(path, "Fixture value path"), "workbench/CHARTER.md"));
    }
    run("record", "add", "decision", "Global retries");
    writeFileSync(
      join(root, "workbench/decisions/ADR-00.md"),
      "---\nsummary: Retry ordinary requests twice.\nagent_instruction: Retry ordinary requests twice.\n---\n\n# ADR-0: Global retries\n",
    );
    run("record", "add", "decision", "Service retries", "--project", "service");
    const local = join(root, "service/workbench/decisions/ADR-00.md");
    const decision =
      "---\nsummary: Retry service requests once.\nagent_instruction: Retry service requests once.\n" +
      "---\n\n# ADR-0: Service retries\n\nThe service has its own retry budget.\n";
    writeFileSync(local, decision);
    run("sync");
    run("format", "--all", "--write");
    run("validate");
    const context = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.equal(context.split(readFileSync(charter, "utf8").trimEnd()).length - 1, 4);
    assert.match(context, /## service\n\nApplies to: `service\/` and descendants/);
    assert.match(context, /## worker\n\nApplies to: `service\/worker\/` and descendants/);
    const serviceContext = required(
      context.split("## service\n")[1],
      'Expected fixture value: context.split("## service\\n")[1]',
    ).split("## worker\n")[0];
    assert.match(required(serviceContext, "Fixture value serviceContext"), /Retry service requests once/);
    assert.doesNotMatch(required(serviceContext, "Fixture value serviceContext"), /Overrides/);
    assert.doesNotMatch(
      required(context.split("## web\n")[1], 'Fixture value context.split("## web\\n")[1]'),
      /Retry service/,
    );
    assert.doesNotMatch(context, /\.workbench\/workbench\/decision-map.md/);
    assert.match(readFileSync(join(root, "service/workbench/decision-map.md"), "utf8"), /Service retries/);
    assert.equal(existsSync(join(root, "service/AGENTS.md")), false);

    run("record", "add", "decision", "Web policy", "--project", "web");
    writeFileSync(local, decision + "\nSee web:ADR-0.\n");
    assert.match(fail("sync"), /outside applicable scope/);
    writeFileSync(local, decision + "\nSee service:ADR-0.\n");
    assert.match(fail("sync"), /earlier decision/);
    writeFileSync(local, decision + "\nSee demo:ADR-Z.\n");
    assert.match(fail("sync"), /ADR reference not found/);
  }));

test("completed records remain readable and allocation never reuses a removed draft", () =>
  fixture(({ root, run }) => {
    run("record", "add", "task", "Parser outcome");
    const first = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(
      first,
      readFileSync(first, "utf8").replace("status: Planned", "status: Done") + "\nEvidence: abc123\n",
    );
    run("record", "add", "task", "Parser follow-up");
    assert.match(readFileSync(first, "utf8"), /Evidence: abc123/);
    assert.doesNotMatch(readFileSync(join(root, "workbench/task-map.md"), "utf8"), /Parser outcome/);
    rmSync(join(root, "workbench/tasks/TSK-01.md"));
    run("record", "add", "task", "New draft");
    assert.ok(existsSync(join(root, "workbench/tasks/TSK-02.md")));
    run("record", "add", "decision", "Parser policy");
    assert.match(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8"), /Parser policy/);
    run("format", "--all", "--write");
    run("validate");
  }));

test("complete checks reject missing structure and implicit empty configuration", () =>
  fixture(({ root, run, fail }) => {
    assert.match(fail("pre-commit"), /no configured check commands/);
    assert.match(run("check", "--list"), /configured: none/);
    const path = join(root, "workbench/config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    assert.match(run("check", "--list"), /structural checks only/);
    assert.match(fail("check", "--role", "test"), /unknown check role 'test'/);
    rmSync(join(root, "workbench/CHARTER.md"));
    assert.match(fail("pre-commit"), /required file is missing/);
  }));
