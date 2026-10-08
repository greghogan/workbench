import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");
const executable = join(distribution, "bundle/main.cjs");

function run(root, expected, ...arguments_) {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
  assert.equal(result.status === 0, expected, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

test("task hierarchy and duplicate dependencies are validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-relationships-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run(root, true, "task", "add", "Parent");
    run(root, true, "task", "add", "Child", "--parent", "demo:TSK-0");
    run(root, true, "validate");
    const parent = join(root, "workbench/tasks/TSK-00.md");
    const child = join(root, "workbench/tasks/TSK-01.md");
    writeFileSync(parent, readFileSync(parent, "utf8").replace("status: Planned", "status: Done"));
    assert.match(run(root, false, "validate"), /unfinished child demo:TSK-1/);
    writeFileSync(
      parent,
      readFileSync(parent, "utf8")
        .replace("status: Done", "status: Planned")
        .replace("parent: null", "parent: demo:TSK-1"),
    );
    assert.match(run(root, false, "validate"), /parent cycle/);
    writeFileSync(parent, readFileSync(parent, "utf8").replace("parent: demo:TSK-1", "parent: null"));
    writeFileSync(
      child,
      readFileSync(child, "utf8").replace("depends_on: []", "depends_on: [demo:TSK-0, demo:TSK-00]"),
    );
    assert.match(run(root, false, "validate"), /duplicate 'depends_on' reference/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ADR instruction metadata and citation library config are validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-validation-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run(root, true, "decision", "add", "Rule");
    const decision = join(root, "workbench/decisions/ADR-00.md");
    const original = readFileSync(decision, "utf8");
    writeFileSync(decision, original.replace("---\n", "---\nagent_instruction: |\n  Do this.\n  Adjacent prose.\n"));
    assert.match(run(root, false, "validate"), /'agent_instruction' must be one nonempty logical line/);
    writeFileSync(decision, original);
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("library/citations", "../outside"));
    assert.match(run(root, false, "validate"), /citations.library_dir/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
