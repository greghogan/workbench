import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { approveReview, checkReview, reviewStatus } from "../src/review.ts";
import { checkDocExamples } from "../src/doc-examples.ts";
import { documentationErrors } from "../src/documentation.ts";

const cli = resolve(import.meta.dirname, "../bin/workbench.mjs");

test("slow commands finish successfully and real failures remain failures", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-timing-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "observe",
        "0.001",
        "--",
        process.execPath,
        "-e",
        'setTimeout(() => require("node:fs").writeFileSync("completed", "done"), 50)',
      ],
      { cwd: temporary, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(temporary, "completed"), "utf8"), "done");
    assert.match(result.stderr, /SLOW suite/);
    const failed = spawnSync(process.execPath, [cli, "observe", "5", "--", process.execPath, "-e", "process.exit(7)"], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /exit status 7/);
    const npm = spawnSync(process.execPath, [cli, "observe", "5", "--", "npm", "--version"], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.equal(npm.status, 0, npm.stderr);
    assert.match(npm.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("approval binds staged records and charter authorship without protecting implementation files", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-review-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const digest = () => {
    const output = spawnSync(process.execPath, [resolve(import.meta.dirname, "../bundle/main.cjs"), "review"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
    });
    assert.equal(output.status, 0, output.stderr);
    return required(
      /Review digest: ([a-f0-9]{64})/.exec(output.stdout),
      "Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(output.stdout)",
    )[1];
  };
  try {
    git("init", "-q");
    mkdirSync(join(root, "workbench"));
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="test"\npath="."\n');
    mkdirSync(join(root, "workbench/decisions"));
    writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Decision\n\nOriginal policy.\n");
    writeFileSync(
      join(root, "workbench/CHARTER.md"),
      readFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md")),
    );
    git("add", ".");
    assert.throws(() => {
      checkReview(root);
    }, /human review/);
    const initial = digest();
    assert.throws(() => {
      approveReview(root, required(initial, "Expected fixture value"), false);
    }, /human authorship/);
    approveReview(root, required(initial, "Expected fixture value"), true);
    checkReview(root);
    writeFileSync(join(root, "code.txt"), "unrelated implementation\n");
    git("add", "code.txt");
    checkReview(root);
    writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Decision\n\nRevised policy.\n");
    git("add", "workbench/decisions/ADR-00.md");
    assert.throws(() => {
      checkReview(root);
    }, /human review/);
    assert.throws(() => {
      approveReview(root, required(initial, "Expected fixture value"), true);
    }, /digest changed/);
    approveReview(root, required(digest(), "Expected fixture value"), true);
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    // File identity alone does not make implementation changes human-reviewed policy.
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "workbench/automation.toml"), "# Updated command wiring\n");
    writeFileSync(join(root, "workbench/quality.json"), '{"coverage":{"lines":100}}\n');
    writeFileSync(join(root, ".github/workflows/checks.yml"), "# Updated workflow\n");
    writeFileSync(join(root, "scripts/check.mjs"), "export {};\n");
    git("add", ".");
    checkReview(root);
    reviewStatus(root);
    writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Decision\n\nAnother revision.\n");
    git("add", "workbench/decisions/ADR-00.md");
    assert.throws(() => {
      checkReview(root);
    }, /human review/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documentation examples reject changed output and failed commands", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-docs-"));
  const path = join(root, "README.md");
  try {
    writeFileSync(path, "```console\n$ printf '42\\n'\n42\n```\n");
    checkDocExamples(path);
    writeFileSync(path, "```console\n$ printf '43\\n'\n42\n```\n");
    assert.throws(() => {
      checkDocExamples(path);
    }, /example failed/);
    writeFileSync(path, "```console\n$ exit 1\n```\n");
    assert.throws(() => {
      checkDocExamples(path);
    }, /example failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped source-map entries cover every referenced file and still reject omissions", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-source-map-"));
  try {
    mkdirSync(join(root, "languages"));
    writeFileSync(join(root, "languages/index.toml"), "# fixture distribution\n");
    mkdirSync(join(root, "workbench"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="test"\npath="."\n');
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[[documentation]]\nproject="test"\nsource_map="workbench/source-map.md"\nsource_paths=["src"]\n',
    );
    for (const name of ["one", "two"]) writeFileSync(join(root, `src/${name}.ts`), "export {};\n");
    const map = join(root, "workbench/source-map.md");
    writeFileSync(map, "- `src/one.ts` owns one concern and\n  `src/two.ts` owns another.\n");
    assert.deepEqual(documentationErrors(root, [map]), []);
    symlinkSync(join(root, "workbench"), join(root, "src/.venv"), "junction");
    assert.deepEqual(documentationErrors(root, [map]), []);
    symlinkSync(join(root, "workbench"), join(root, "src/linked-source"), "junction");
    assert.deepEqual(documentationErrors(root, [map]), [
      `workbench/source-map.md: ${join(root, "src/linked-source")}: expected a real project path; symlinks are not supported`,
    ]);
    rmSync(join(root, "src/linked-source"));
    writeFileSync(map, "- `src/one.ts` owns one concern.\n");
    assert.deepEqual(documentationErrors(root, [map]), [`${map}: source map does not cover 'src/two.ts'`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
