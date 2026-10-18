import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { test } from "vitest";
import type { SpawnSyncReturns } from "child_process";

const distribution = resolve(import.meta.dirname, "..");
interface FormattingFixture {
  root: string;
  invoke: (args: string[], input?: string) => SpawnSyncReturns<string>;
  run: (...args: string[]) => string;
  fail: (...args: string[]) => string;
}
function fixture(action: (fixture: FormattingFixture) => void) {
  const root = mkdtempSync(join(tmpdir(), "workbench-format-"));
  const invoke = (args: string[], input?: string) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    });
  const run = (...args: string[]) => {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const fail = (...args: string[]) => {
    const result = invoke(args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  try {
    run("setup-project", root);
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run("sync");
    action({ root, run, fail, invoke });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const metadata = (contents: string): unknown =>
  parse(required(contents.split("---")[1], 'Fixture value contents.split("---")[1]'));

test("validation checks user documentation in root and subproject docs directories without following links", () => {
  fixture(({ root, run, fail }) => {
    run("project", "add", "api", "api");
    copyFileSync(join(root, "workbench/CHARTER.md"), join(root, "api/workbench/CHARTER.md"));
    run("sync");
    for (const owner of [root, join(root, "api")]) {
      mkdirSync(join(owner, "docs"));
      const guide = join(owner, "docs/start.md");
      writeFileSync(guide, "[Charter](../workbench/CHARTER.md)\n");
      run("validate");
      writeFileSync(guide, "[Missing](missing.md)\n");
      assert.match(fail("validate"), /missing link target.*missing\.md/);
      writeFileSync(guide, "[Charter](../workbench/CHARTER.md)\n");
    }
    const outside = mkdtempSync(join(tmpdir(), "workbench-external-docs-"));
    try {
      writeFileSync(join(outside, "broken.md"), "[Missing](missing.md)\n");
      symlinkSync(outside, join(root, "docs/external"), "junction");
      run("validate");
      rmSync(join(root, "api/docs"), { recursive: true });
      symlinkSync(outside, join(root, "api/docs"), "junction");
      run("validate");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("task creation formats file and stdin bodies and scopes batch formatting", () => {
  fixture(({ root, run, invoke }) => {
    run("project", "add", "api", "api");
    copyFileSync(join(root, "workbench/CHARTER.md"), join(root, "api/workbench/CHARTER.md"));
    const source = join(root, "draft.md");
    const body =
      "## Context\n\n" + "An explanation with several words. ".repeat(14) + "\n\n*   An item\n*   Another item\n";
    writeFileSync(source, body);
    run("record", "add", "task", "From file", "--from", source);
    const result = invoke(["record", "add", "task", "From stdin", "--from", "-", "--project", "api"], body);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rootTask = join(root, "workbench/tasks/TSK-00.md");
    const localTask = join(root, "api/workbench/tasks/TSK-00.md");
    assert.match(readFileSync(rootTask, "utf8"), /# TSK-0: From file/);
    assert.match(readFileSync(localTask, "utf8"), /# TSK-0: From stdin/);
    assert.deepEqual(metadata(readFileSync(rootTask, "utf8")), {
      status: "Planned",
    });
    assert.equal(readFileSync(source, "utf8"), body);
    run("format", "--all", "--check");
    const untouched = ["workbench/CHARTER.md", "api/workbench/CHARTER.md", "AGENTS.md", "workbench/task-map.md"].map(
      (path) => [path, readFileSync(join(root, path), "utf8")] as const,
    );
    mkdirSync(join(root, ".workbench/workbench/tasks"), { recursive: true });
    const dependency = join(root, ".workbench/workbench/tasks/TSK-00.md");
    writeFileSync(dependency, "unformatted dependency record");
    for (const path of [rootTask, localTask]) writeFileSync(path, readFileSync(path, "utf8") + "\n\n");
    const original = readFileSync(rootTask, "utf8");
    run("format", "--all", "--project", "api", "--write");
    assert.equal(readFileSync(rootTask, "utf8"), original);
    run("format", "--all", "--write");
    run("format", "--all", "--check");
    assert.equal(readFileSync(dependency, "utf8"), "unformatted dependency record");
    for (const [path, contents] of untouched) assert.equal(readFileSync(join(root, path), "utf8"), contents);
  });
});

test("formatting preserves YAML values, comments, hard breaks, and embedded evidence", () => {
  fixture(({ root, run }) => {
    const path = join(root, "document.md");
    const code = "function evidence(  x ){return  x+1;}\n";
    const before =
      '---\n# Preserve metadata comments\nschema_version:    1\nextensions:\n  flag: "false"\n  order: [second,first]\n  notes: |\n    first\n    second\n---\n\n# Evidence\n\nFirst line  \nSecond line\n\n' +
      "*   " +
      "Nested prose with spaces. ".repeat(12) +
      "\n\n```js\n" +
      code +
      "```\n";
    writeFileSync(path, before);
    run("format", path, "--write");
    const after = readFileSync(path, "utf8");
    assert.deepEqual(metadata(after), metadata(before));
    assert.match(after, /# Preserve metadata comments/);
    assert.ok(after.includes("```js\n" + code + "```"));
    assert.match(after, /First line(?: {2}|\\)\nSecond line/);
    run("format", path, "--check");
    run("format", path, "--write");
    assert.equal(readFileSync(path, "utf8"), after);
    const yaml = join(root, "document.yaml");
    const values =
      '# Citation comment\nquoted: "001"\nflag: "false"\nsequence: [b,a]\ntext: >-\n  one two\n  three four\n';
    writeFileSync(yaml, values);
    run("format", yaml, "--write");
    assert.deepEqual(parse(readFileSync(yaml, "utf8")), parse(values));
    assert.match(readFileSync(yaml, "utf8"), /# Citation comment/);
    run("format", yaml, "--check");
  });
});

test("draft completeness and formatting are separate and checks never rewrite records", () => {
  fixture(({ root, run, fail }) => {
    run("record", "add", "environment", "Unspecified hardware");
    run("record", "add", "citation", "Unspecified paper");
    run("format", "--all", "--check");
    assert.match(fail("validate"), /Hardware configuration|author/);
    run("record", "add", "task", "Draft task");
    const path = join(root, "workbench/tasks/TSK-00.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("status: Planned\n", "{}\n"));
    run("format", path, "--write");
    run("format", "--all", "--check");
    assert.match(fail("validate"), /'status' must be/);
    writeFileSync(path, original + "\n\n");
    const unformatted = readFileSync(path, "utf8");
    assert.match(fail("validate"), /formatting differs/);
    assert.match(fail("format", "--all", "--check"), /formatting differs/);
    assert.equal(readFileSync(path, "utf8"), unformatted);
  });
});

test("malformed batch input and invalid CLI combinations leave files unchanged", () => {
  fixture(({ root, run, fail }) => {
    run("record", "add", "task", "Keep unchanged");
    const task = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(task, readFileSync(task, "utf8") + "\n\n");
    const original = readFileSync(task, "utf8");
    run("project", "add", "api", "api");
    const citation = join(root, "api/workbench/citations/CIT-00.json");
    mkdirSync(join(root, "api/workbench/citations"), { recursive: true });
    writeFileSync(citation, "[{broken JSON]\n");
    assert.match(fail("format", "--all", "--write"), /JSON|property name|Expected/i);
    assert.equal(readFileSync(task, "utf8"), original);
    assert.match(fail("format", "--all"), /requires --write or --check/);
    assert.match(fail("format", task, "--all", "--write"), /file path or --all/);
    assert.match(fail("format", task, "--project", "api"), /--project requires --all/);
    const input = join(root, "draft.md");
    writeFileSync(input, "---\nstatus: Active\n---\n\n## Context\nBody.\n");
    assert.match(fail("record", "add", "task", "Bad input", "--from", input), /body without frontmatter/);
    assert.equal(existsSync(join(root, "workbench/tasks/TSK-01.md")), false);
  });
});

test("prose schemas reject typos and duplicate keys, while folded metadata remains usable", () => {
  fixture(({ root, run, fail }) => {
    run("record", "add", "decision", "Metadata policy");
    const path = join(root, "workbench/decisions/ADR-00.md");
    const original =
      "---\nsummary: >-\n  A summary spread across\n  source lines.\nagent_instruction: >-\n  Follow this instruction\n  before implementation.\nextensions:\n  owner: research\n---\n\n# ADR-0: Metadata policy\n";
    writeFileSync(path, original);
    run("format", "--all", "--write");
    run("sync");
    run("validate");
    // A comment in YAML frontmatter is not a Markdown anchor.
    writeFileSync(path, readFileSync(path, "utf8").replace("summary:", "# Hidden metadata heading\nsummary:"));
    writeFileSync(join(root, "README.md"), "[Hidden](workbench/decisions/ADR-00.md#hidden-metadata-heading)\n");
    assert.match(fail("validate"), /missing Markdown anchor/);
    rmSync(join(root, "README.md"));
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /Follow this instruction before implementation\./);
    assert.match(
      readFileSync(join(root, "workbench/decision-map.md"), "utf8"),
      /A summary spread across source lines\./,
    );
    writeFileSync(path, original.replace("summary:", "summray:"));
    assert.match(fail("validate"), /unknown ADR metadata 'summray'/);
    writeFileSync(path, original.replace("summary:", "summary: duplicate\nsummary:"));
    assert.match(fail("format", path, "--write"), /unique|duplicate/i);
    writeFileSync(path, original.replace("# ADR-0:", "    # ADR-0:"));
    assert.match(fail("validate"), /invalid title/);
  });
});
