import { recordDocument } from "../../../src/core/records/record-document.ts";
import { required } from "../../../src/core/runtime/invariants.ts";
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
import { afterEach, test, vi } from "vitest";
import { addProject, setupProject } from "../../../src/cli/project-setup.ts";
import { addRecord } from "../../../src/core/records/records.ts";
import { formatFiles } from "../../../src/core/records/formatting.ts";
import { synchronize } from "../../../src/core/records/sync.ts";
import { validate, validationReport } from "../../../src/core/records/validation.ts";

afterEach(() => vi.unstubAllEnvs());
import type { SpawnSyncReturns } from "child_process";

const distribution = resolve(import.meta.dirname, "../../../..");
interface FormattingFixture {
  root: string;
  invoke: (args: string[], input?: string) => SpawnSyncReturns<string>;
  run: (...args: string[]) => string;
  fail: (...args: string[]) => string;
}
async function fixture(action: (fixture: FormattingFixture) => Promise<void>) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
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
    await setupProject(root, "format");
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    synchronize(root);
    await action({ root, run, fail, invoke });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const metadata = (contents: string): unknown =>
  parse(required(contents.split("---")[1], 'Fixture value contents.split("---")[1]'));
const validationErrors = async (root: string) => (await validationReport(root)).errors.join("\n");

test("validation checks user documentation in root and subproject docs directories without following links", () => {
  return fixture(async ({ root }) => {
    await addProject(root, "api", "api");
    copyFileSync(join(root, "workbench/CHARTER.md"), join(root, "api/workbench/CHARTER.md"));
    synchronize(root);
    for (const owner of [root, join(root, "api")]) {
      mkdirSync(join(owner, "docs"));
      const guide = join(owner, "docs/start.md");
      writeFileSync(guide, "[Charter](../workbench/CHARTER.md)\n");
      await validate(root);
      writeFileSync(guide, "[Missing](missing.md)\n");
      assert.match(await validationErrors(root), /missing link target.*missing\.md/);
      writeFileSync(guide, "[Charter](../workbench/CHARTER.md)\n");
    }
    const outside = mkdtempSync(join(tmpdir(), "workbench-external-docs-"));
    try {
      writeFileSync(join(outside, "broken.md"), "[Missing](missing.md)\n");
      symlinkSync(outside, join(root, "docs/external"), "junction");
      await validate(root);
      rmSync(join(root, "api/docs"), { recursive: true });
      symlinkSync(outside, join(root, "api/docs"), "junction");
      await validate(root);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("task creation formats file and stdin bodies and scopes batch formatting", () => {
  return fixture(async ({ root, run, invoke }) => {
    await addProject(root, "api", "api");
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
    const { added_at, ...fields } = recordDocument("TSK", readFileSync(rootTask, "utf8"), rootTask).metadata;
    assert.equal(typeof added_at, "string");
    assert.deepEqual(fields, { status: "Planned" });
    assert.equal(readFileSync(source, "utf8"), body);
    await formatFiles(root, undefined, { all: true, check: true });
    const untouched = ["workbench/CHARTER.md", "api/workbench/CHARTER.md", "AGENTS.md", "workbench/task-map.md"].map(
      (path) => [path, readFileSync(join(root, path), "utf8")] as const,
    );
    mkdirSync(join(root, ".workbench/workbench/tasks"), { recursive: true });
    const dependency = join(root, ".workbench/workbench/tasks/TSK-00.md");
    writeFileSync(dependency, "unformatted dependency record");
    for (const path of [rootTask, localTask]) writeFileSync(path, readFileSync(path, "utf8") + "\n\n");
    const original = readFileSync(rootTask, "utf8");
    await formatFiles(root, undefined, { all: true, project: "api", write: true });
    assert.equal(readFileSync(rootTask, "utf8"), original);
    await formatFiles(root, undefined, { all: true, write: true });
    await formatFiles(root, undefined, { all: true, check: true });
    assert.equal(readFileSync(dependency, "utf8"), "unformatted dependency record");
    for (const [path, contents] of untouched) assert.equal(readFileSync(join(root, path), "utf8"), contents);
  });
});

test("formatting preserves YAML values, comments, hard breaks, and embedded evidence", () => {
  return fixture(async ({ root }) => {
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
    await formatFiles(root, path, { write: true });
    const after = readFileSync(path, "utf8");
    assert.deepEqual(metadata(after), metadata(before));
    assert.match(after, /# Preserve metadata comments/);
    assert.ok(after.includes("```js\n" + code + "```"));
    assert.match(after, /First line(?: {2}|\\)\nSecond line/);
    await formatFiles(root, path, { check: true });
    await formatFiles(root, path, { write: true });
    assert.equal(readFileSync(path, "utf8"), after);
    const yaml = join(root, "document.yaml");
    const values =
      '# Citation comment\nquoted: "001"\nflag: "false"\nsequence: [b,a]\ntext: >-\n  one two\n  three four\n';
    writeFileSync(yaml, values);
    await formatFiles(root, yaml, { write: true });
    assert.deepEqual(parse(readFileSync(yaml, "utf8")), parse(values));
    assert.match(readFileSync(yaml, "utf8"), /# Citation comment/);
    await formatFiles(root, yaml, { check: true });
  });
});

test("draft completeness and formatting are separate and checks never rewrite records", () => {
  return fixture(async ({ root }) => {
    await addRecord(root, "ENV", "Unspecified hardware");
    await addRecord(root, "CIT", "Unspecified paper");
    await formatFiles(root, undefined, { all: true, check: true });
    assert.match(await validationErrors(root), /Hardware configuration|author/);
    await addRecord(root, "TSK", "Draft task");
    const path = join(root, "workbench/tasks/TSK-00.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace(/^---\n[\s\S]*?\n---/, "---\n{}\n---"));
    await formatFiles(root, path, { write: true });
    await formatFiles(root, undefined, { all: true, check: true });
    assert.match(await validationErrors(root), /'status' must be/);
    writeFileSync(path, original + "\n\n");
    const unformatted = readFileSync(path, "utf8");
    assert.match(await validationErrors(root), /formatting differs/);
    await assert.rejects(() => formatFiles(root, undefined, { all: true, check: true }), /formatting differs/);
    assert.equal(readFileSync(path, "utf8"), unformatted);
  });
});

test("malformed batch input and invalid CLI combinations leave files unchanged", () => {
  return fixture(async ({ root, fail }) => {
    await addRecord(root, "TSK", "Keep unchanged");
    const task = join(root, "workbench/tasks/TSK-00.md");
    writeFileSync(task, readFileSync(task, "utf8") + "\n\n");
    const original = readFileSync(task, "utf8");
    await addProject(root, "api", "api");
    const citation = join(root, "api/workbench/citations/CIT-00.json");
    mkdirSync(join(root, "api/workbench/citations"), { recursive: true });
    writeFileSync(citation, "[{broken JSON]\n");
    await assert.rejects(
      () => formatFiles(root, undefined, { all: true, write: true }),
      /JSON|property name|Expected/i,
    );
    assert.equal(readFileSync(task, "utf8"), original);
    assert.match(fail("format", "--all"), /requires --write or --check/);
    assert.match(fail("format", task, "--all", "--write"), /file path or --all/);
    assert.match(fail("format", task, "--project", "api"), /--project requires --all/);
    const input = join(root, "draft.md");
    writeFileSync(input, "---\nstatus: Approved\n---\n\n## Context\nBody.\n");
    assert.match(fail("record", "add", "task", "Bad input", "--from", input), /body without frontmatter/);
    assert.equal(existsSync(join(root, "workbench/tasks/TSK-01.md")), false);
  });
});

test("prose schemas reject typos and duplicate keys, while folded metadata remains usable", () => {
  return fixture(async ({ root }) => {
    await addRecord(root, "ADR", "Metadata policy");
    const path = join(root, "workbench/decisions/ADR-00.md");
    const original =
      "---\nsummary: >-\n  A summary spread across\n  source lines.\nagent_instruction: >-\n  Follow this instruction\n  before implementation.\nextensions:\n  owner: research\n---\n\n# ADR-0: Metadata policy\n";
    writeFileSync(path, original);
    await formatFiles(root, undefined, { all: true, write: true });
    synchronize(root);
    await validate(root);
    // A comment in YAML frontmatter is not a Markdown anchor.
    writeFileSync(path, readFileSync(path, "utf8").replace("summary:", "# Hidden metadata heading\nsummary:"));
    writeFileSync(join(root, "README.md"), "[Hidden](workbench/decisions/ADR-00.md#hidden-metadata-heading)\n");
    assert.match(await validationErrors(root), /missing Markdown anchor/);
    rmSync(join(root, "README.md"));
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /Follow this instruction before implementation\./);
    assert.match(
      readFileSync(join(root, "workbench/decision-map.md"), "utf8"),
      /A summary spread across source lines\./,
    );
    writeFileSync(path, original.replace("summary:", "summray:"));
    assert.match(await validationErrors(root), /unknown\s+ADR\s+metadata\s+'summray'/);
    writeFileSync(path, original.replace("summary:", "summary: duplicate\nsummary:"));
    await assert.rejects(() => formatFiles(root, path, { write: true }), /unique|duplicate/i);
    writeFileSync(path, original.replace("# ADR-0:", "    # ADR-0:"));
    assert.match(await validationErrors(root), /invalid title/);
  });
});
