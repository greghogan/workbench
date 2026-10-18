import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "smol-toml";
import { checkRecordRetention } from "../src/record-retention.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(paths: string[] = [], scopes = ["."]) {
  const root = mkdtempSync(join(tmpdir(), "workbench-retention-"));
  temporary.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const registry = (selected: string[]) => {
    writeFileSync(
      join(root, "workbench/projects.toml"),
      stringify({
        project: selected.map((path, index) => ({ id: `scope${String(index)}`, path })),
      }),
    );
  };
  git("init", "-q");
  mkdirSync(join(root, "workbench"));
  registry(scopes);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "retained fixture\n");
  }
  git("add", ".");
  git("commit", "-qm", "Baseline");
  return { root, git, registry };
}

test.each([
  "decisions/ADR-00.md",
  "tasks/TSK-00.md",
  "experiments/EXP-00.md",
  "environments/ENV-00.md",
  "citations/CIT-00.json",
  "releases/REL-00.yaml",
])("committed canonical %s cannot be deleted", (path) => {
  const record = `workbench/${path}`;
  const { root, git } = fixture([record]);
  git("rm", record);
  const before = git("diff", "--cached", "--binary");
  expect(() => {
    checkRecordRetention(root);
  }).toThrow(`instead of deleting ${record}`);
  expect(git("diff", "--cached", "--binary")).toBe(before);
});

test("independent exports and record-shaped supporting files can be removed", () => {
  const exported = "exports/company/1/workbench/decisions/ADR-00.md";
  const supporting = "workbench/decisions/ADR-00/evidence/workbench/decisions/ADR-01.md";
  const { root, git } = fixture([exported, supporting, "workbench/decisions/ADR-00.md"]);
  git("rm", exported, supporting);
  const before = git("diff", "--cached", "--binary");
  expect(() => {
    checkRecordRetention(root);
  }).not.toThrow();
  expect(git("diff", "--cached", "--binary")).toBe(before);
});

test("removing a committed scope registration cannot bypass record retention", () => {
  const record = "app/workbench/environments/01/ENV-0100.md";
  const { root, git, registry } = fixture([record], [".", "app"]);
  registry(["."]);
  git("add", "workbench/projects.toml");
  git("rm", record);
  expect(() => {
    checkRecordRetention(root);
  }).toThrow(`instead of deleting ${record}`);
});

test("new staged scope registrations also retain their existing records", () => {
  const record = "app/workbench/decisions/ADR-00.md";
  const { root, git, registry } = fixture([record]);
  registry([".", "app"]);
  git("add", "workbench/projects.toml");
  git("rm", record);
  expect(() => {
    checkRecordRetention(root);
  }).toThrow(`instead of deleting ${record}`);
});

test("unstaged scope registration changes do not alter retention decisions", () => {
  const exported = "exports/company/workbench/decisions/ADR-00.md";
  const { root, git, registry } = fixture([exported]);
  git("rm", exported);
  registry([".", "exports/company"]);
  expect(() => {
    checkRecordRetention(root);
  }).not.toThrow();
});

test("renaming an existing canonical record cannot discard its old path", () => {
  const { root, git } = fixture(["workbench/decisions/ADR-00.md"]);
  git("mv", "workbench/decisions/ADR-00.md", "workbench/decisions/ADR-01.md");
  expect(() => {
    checkRecordRetention(root);
  }).toThrow("instead of deleting workbench/decisions/ADR-00.md");
});

test("an initial commit with new records has no committed records to retain", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-new-records-"));
  temporary.push(root);
  expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "new decision\n");
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(() => {
    checkRecordRetention(root);
  }).not.toThrow();
});
