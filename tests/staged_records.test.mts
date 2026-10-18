import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "smol-toml";
import { checkReview } from "../src/review.ts";
import { proposedRecordTrees, stagedRecordTree } from "../src/staged-records.ts";
import { projectsFromData } from "../src/core.ts";
import { git } from "./fixtures/adoption.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(scopes = ["."], collections: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "workbench-staged-records-"));
  roots.push(root);
  git(root, "init", "-q");
  const put = (path: string, bytes: string | NodeJS.ArrayBufferView) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const registry = (paths: string[]) => {
    put("workbench/projects.toml", stringify({ project: paths.map((path, i) => ({ id: `scope${String(i)}`, path })) }));
  };
  const pins = (ids: string[]) => {
    put(
      "workbench/config.toml",
      stringify({
        collections: {
          sources: ids.map((id) => ({
            id,
            revision: "1",
            sha256: "1".repeat(64),
            visibility: "public",
            scopes: ["."],
            source: root,
            commit: "1".repeat(40),
            collection: ".",
          })),
        },
      }),
    );
  };
  registry(scopes);
  pins(collections);
  return { root, put, registry, pins, stage: () => git(root, "add", ".") };
}

test("exports and fixture policies do not require approval, but registered records and supporting files do", () => {
  const { root, put, stage } = fixture();
  for (const path of ["exports/company/workbench/decisions/ADR-00.md", "tests/fixtures/workbench/CHARTER.md"])
    put(path, "Independent material.\n");
  stage();
  expect(() => {
    checkReview(root);
  }).not.toThrow();
  put("workbench/experiments/EXP-00/run.json", "{}\n");
  stage();
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});

test.each(["scope", "collection"])("removing a committed %s declaration cannot bypass approval", (kind) => {
  const { root, put, registry, pins, stage } = fixture([".", "app"], ["company"]);
  const path =
    kind === "scope" ? "app/workbench/decisions/ADR-00.md" : "workbench/collections/company/decisions/ADR-00.md";
  put(path, "Existing decision.\n");
  stage();
  git(root, "commit", "-qm", "Baseline");
  if (kind === "scope") registry(["."]);
  else pins([]);
  git(root, "rm", path);
  stage();
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});

test("new staged scopes protect records, while unstaged scope additions do not", () => {
  const { root, put, registry, stage } = fixture();
  put("app/workbench/decisions/ADR-00.md", "New scope policy.\n");
  stage();
  registry([".", "app"]);
  expect(() => {
    checkReview(root);
  }).not.toThrow();
  stage();
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});

test("immutable tree reads preserve binary supporting files despite later staging", () => {
  const { root, put, stage } = fixture();
  const path = "workbench/decisions/ADR-00/data.bin";
  put(path, Buffer.from([0, 255, 128]));
  stage();
  const tree = stagedRecordTree(root);
  const index = git(root, "write-tree");
  put(path, Buffer.from([1, 2]));
  expect(tree.bytes(path)).toEqual(Buffer.from([0, 255, 128]));
  expect(git(root, "write-tree")).toBe(index);
  stage();
  expect(tree.bytes(path)).toEqual(Buffer.from([0, 255, 128]));
  expect(stagedRecordTree(root).bytes(path)).toEqual(Buffer.from([1, 2]));
  expect(proposedRecordTrees(root)).toHaveLength(1);
});

test("pure registry validation rejects duplicate and unsafe scope declarations", () => {
  expect(projectsFromData({ project: [{ id: "root", path: "." }] }, "registry")).toEqual([{ id: "root", path: "." }]);
  for (const entry of [
    { id: "root", path: "app" },
    { id: "app", path: "../outside" },
  ])
    expect(() => projectsFromData({ project: [{ id: "root", path: "." }, entry] }, "registry")).toThrow(
      /duplicate|unsafe/,
    );
});

test("Git symlinks cannot stand in for registered project directories or policy files", () => {
  const { root, put, stage } = fixture([".", "app"]);
  put("target.txt", "outside-checkout");
  stage();
  const object = git(root, "hash-object", "-w", "target.txt");
  git(root, "update-index", "--add", "--cacheinfo", `120000,${object},app`);
  expect(() => stagedRecordTree(root)).toThrow(/expected a project directory/);
  git(root, "update-index", "--force-remove", "app");
  git(root, "update-index", "--add", "--cacheinfo", `120000,${object},workbench/decisions/ADR-00.md`);
  const tree = stagedRecordTree(root);
  expect(() => tree.bytes("workbench/decisions/ADR-00.md")).toThrow(/expected a regular policy file/);
});
