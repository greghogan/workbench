import { afterEach, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../../fixtures/adoption.mjs";
import { updatedReviewTree, writeRawReviewObjects } from "../../../src/core/git/git-snapshot.ts";
import { integrationTarget } from "../../../src/core/git/integration-target.ts";
import {
  readArchiveIndex,
  readArchivedFile,
  readInventoryRecords,
  recordInventory,
} from "../../../src/core/records/archive-store.ts";
import { updateProjectState } from "../../../src/core/projects/project-state.ts";
import { reserveRecordNumber } from "../../../src/core/records/record-sequences.ts";
import { parse } from "smol-toml";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "workbench-archive-store-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[records]\narchive_branch="archive"\n',
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="sample"\npath="."\n');
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  return root;
}
function archive(root: string, files: Record<string, { body: string; mode?: string }>, parent?: string): string {
  const updates = Object.entries(files).map(([path, file], index) => {
    const scratch = join(root, `.git/blob-${String(index)}`);
    writeFileSync(scratch, file.body);
    const oid = writeRawReviewObjects(root, [scratch])[0];
    if (!oid) throw new Error("Missing fixture blob");
    return { path, entry: { mode: file.mode ?? "100644", oid } };
  });
  const tree = updatedReviewTree(root, "", updates);
  return git(root, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Archive records");
}
const task = "workbench/tasks/TSK-00.md";

test("pinned orphan archives preserve bytes and modes through later tips, disable, and garbage collection", () => {
  const root = repository();
  const body = "---\nstatus: Accepted\n---\n\n# TSK-0: Delivered\n\nExact bytes.\r\n";
  const revision = archive(root, {
    [task]: { body },
    "workbench/tasks/TSK-00/evidence.sh": { body: "#!/bin/sh\nexit 0\n", mode: "100755" },
  });
  git(root, "update-ref", "refs/heads/archive", revision);
  updateProjectState(root, (state) => {
    state.archive = { revision };
  });
  expect(git(root, "rev-list", "--count", revision)).toBe("1");
  expect(readArchivedFile(root, task)?.toString()).toBe(body);
  expect(existsSync(join(root, task))).toBe(false);
  expect(readArchiveIndex(root, revision).files.get("workbench/tasks/TSK-00/evidence.sh")?.mode).toBe("100755");
  const next = archive(root, {}, revision);
  git(root, "update-ref", "refs/heads/archive", next, revision);
  git(root, "gc", "--prune=now");
  expect(readArchivedFile(root, task)?.toString()).toBe(body);
  expect(readArchiveIndex(root, next).records).toEqual([]);
  const inventory = recordInventory(root, ".", "TSK");
  expect(inventory.map((item) => item.number)).toEqual(["0"]);
  expect(readInventoryRecords(root, inventory).get(join(root, task))?.toString()).toBe(body);
});

test("one inventory deduplicates identical copies but refuses different content or executable modes", () => {
  const root = repository(),
    body = "---\nstatus: Accepted\n---\n\n# TSK-0: Existing\n";
  const revision = archive(root, { [task]: { body } });
  updateProjectState(root, (state) => {
    state.archive = { revision };
  });
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, task), body);
  expect(recordInventory(root, ".", "TSK")).toHaveLength(1);
  writeFileSync(join(root, task), body + "changed");
  expect(() => recordInventory(root, ".", "TSK")).toThrow(/contents differ/);
  writeFileSync(join(root, task), body);
  if (process.platform !== "win32") {
    chmodSync(join(root, task), 0o755);
    expect(() => recordInventory(root, ".", "TSK")).toThrow(/contents differ/);
  }
});

test("an archived record and a Git-converted working copy share one inventory entry", () => {
  const root = repository();
  const body = "---\nstatus: Accepted\n---\n\n# TSK-0: Existing\n";
  const revision = archive(root, { [task]: { body } });
  updateProjectState(root, (state) => {
    state.archive = { revision };
  });
  writeFileSync(join(root, ".gitattributes"), "*.md text eol=crlf\n");
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, task), body.replaceAll("\n", "\r\n"));

  const inventory = recordInventory(root, ".", "TSK");
  expect(inventory).toHaveLength(1);
  expect(readInventoryRecords(root, inventory).get(join(root, task))?.toString()).toBe(body);
});

test("unavailable archives and configuration removal never become empty inventories", () => {
  const root = repository();
  updateProjectState(root, (state) => {
    state.archive = { revision: "a".repeat(40) };
  });
  expect(() => recordInventory(root, ".", "TSK")).toThrow(/archive fetch/);
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  expect(() => readArchivedFile(root, task)).toThrow(/restore them before clearing/);
});

test.each([
  { "application.ts": { body: "code" } },
  { "workbench/tasks/TSK-0.md": { body: "wrong path" } },
  { "workbench/tasks/TSK-00/orphan.txt": { body: "orphan" } },
  { "workbench/tasks/TSK-00.md": { body: "link", mode: "120000" } },
])("archive-only trees reject unrelated, noncanonical, orphan, or unsafe entries", (files) => {
  const root = repository(),
    revision = archive(root, files);
  expect(() => readArchiveIndex(root, revision)).toThrow(/Archive|archive|Archived|archived/);
});

test("archive updates and record allocation preserve each other's fields and comments", () => {
  const root = repository();
  writeFileSync(join(root, "workbench/state.toml"), '# Keep this\n[next]\nTSK="A"\n');
  const revision = archive(root, { [task]: { body: "---\nstatus: Accepted\n---\n\n# TSK-0: Completed\n" } });
  updateProjectState(root, (state) => {
    state.archive = { revision };
  });
  expect(reserveRecordNumber(root, "TSK")).toBe("A");
  const state = parse(readFileSync(join(root, "workbench/state.toml"), "utf8"));
  expect(state.archive).toEqual({ revision });
  expect(state.next).toMatchObject({ TSK: "B" });
  expect(readFileSync(join(root, "workbench/state.toml"), "utf8")).toContain("# Keep this");
});

test("integration discovery proposes a local default, follows remote HEAD, and refuses ambiguous remotes", () => {
  const root = repository();
  expect(integrationTarget(root)).toEqual({ branch: "main" });
  git(root, "remote", "add", "origin", "https://example.invalid/sample");
  git(root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(integrationTarget(root)).toEqual({ branch: "trunk", remote: "origin" });
  git(root, "remote", "add", "upstream", "https://example.invalid/upstream");
  expect(() => integrationTarget(root)).toThrow(/multiple remotes/);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[integration]\nbranch="main"\nremote="upstream"\n');
  expect(integrationTarget(root)).toEqual({ branch: "main", remote: "upstream" });
});
