import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspaceCollector, WorkspaceIndex, workspaceSnapshotBytes } from "../src/workspace-service.ts";
import { decodeWorkspaceSnapshot } from "../src/web/workspace-codec.ts";
import { webServers } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";

const fixtures = webServers();
test("workspace messages validate nested documents and comparison outcomes before publication", () => {
  const snapshot = new WorkspaceCollector(fixtures.project()).collect();
  expect(decodeWorkspaceSnapshot(snapshot)).toBe(snapshot);
  const badRecord = structuredClone(snapshot);
  if (!badRecord.records[0]) throw new Error("Missing fixture record");
  Object.assign(badRecord.records[0], { editable: "yes" });
  expect(() => decodeWorkspaceSnapshot(badRecord)).toThrow("invalid workspace worker snapshot");
  const badDifference = structuredClone(snapshot);
  const document = badDifference.documents.values().next().value;
  if (!document) throw new Error("Missing fixture document");
  Object.assign(document, { reviewed: { state: "available", difference: { patch: [], before: "", after: "" } } });
  expect(() => decodeWorkspaceSnapshot(badDifference)).toThrow("invalid workspace worker snapshot");
  const badFormatting = structuredClone(snapshot);
  badFormatting.formatting.results.set("workbench/CHARTER.md", {
    state: "changed",
    input: "0".repeat(64),
    file: { path: "workbench/CHARTER.md", formatted: "formatted", mode: "100644" },
  });
  Object.assign(badFormatting.formatting.results.values().next().value ?? {}, { state: "unknown" });
  expect(() => decodeWorkspaceSnapshot(badFormatting)).toThrow("invalid workspace worker snapshot");
  const badBaseline = structuredClone(snapshot);
  const baselineDocument = badBaseline.documents.values().next().value;
  if (!baselineDocument) throw new Error("Missing fixture document");
  Object.assign(baselineDocument, { baseline: { kind: "review", approvedAt: "not a timestamp" } });
  expect(() => decodeWorkspaceSnapshot(badBaseline)).toThrow("invalid workspace worker snapshot");
});

test("case-insensitive body search remains current across reused workspace indexes", () => {
  const root = fixtures.project();
  const collector = new WorkspaceCollector(root);
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# ADR-0: Files\n\nDistinctive Alpha phrase.\n");
  const first = new WorkspaceIndex(collector.collect());
  const query = (index: WorkspaceIndex, text: string) =>
    index
      .select({})
      .searchRecords({ type: "ADR", scope: "", query: text })
      .map((record) => record.id);
  expect(query(first, "ALPHA PHRASE")).toEqual(["demo:ADR-0"]);
  const same = new WorkspaceIndex(collector.collect(), first);
  expect(query(same, "alpha phrase")).toEqual(["demo:ADR-0"]);
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# ADR-0: Files\n\nDistinctive Beta phrase.\n");
  const changed = new WorkspaceIndex(collector.collect(), same);
  expect(query(changed, "alpha phrase")).toEqual([]);
  expect(query(changed, "BETA PHRASE")).toEqual(["demo:ADR-0"]);
});

test("unchanged acquisition reuses bodies and Git state; directory changes and forced refresh reconcile", () => {
  const root = fixtures.project(),
    collector = new WorkspaceCollector(root);
  const first = collector.collect();
  expect(collector.collect()).toBe(first);
  const forced = collector.collect(true);
  expect(forced).not.toBe(first);
  expect(forced.revision).toBe(first.revision);
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "# TSK-0: New work\n\nFind this body.\n");
  const added = collector.collect();
  expect(added.records.some((record) => record.id === "demo:TSK-0")).toBe(true);
  expect(added.revision).not.toBe(forced.revision);
  mkdirSync(join(root, "workbench/tasks/TSK-00"));
  writeFileSync(join(root, "workbench/tasks/TSK-00/evidence.txt"), "first");
  const supported = collector.collect();
  expect(supported.documents.get("demo:TSK-0")?.files).toEqual([
    { path: "workbench/tasks/TSK-00/evidence.txt", size: 5 },
  ]);
  writeFileSync(join(root, "workbench/tasks/TSK-00/next.txt"), "next");
  expect(collector.collect().documents.get("demo:TSK-0")?.files).toHaveLength(2);
});
test("snapshot accounting includes metadata, supporting paths, errors, maps, and shared objects", () => {
  const shared = { message: "failure" };
  expect(workspaceSnapshotBytes({ errors: [shared, shared] })).toBeLessThan(
    workspaceSnapshotBytes({ errors: [shared, { ...shared }] }),
  );
  expect(
    workspaceSnapshotBytes({
      summary: "a".repeat(1000),
      files: [{ path: "b".repeat(1000) }],
      problem: "c".repeat(1000),
    }),
  ).toBeGreaterThan(6000);
  expect(workspaceSnapshotBytes(new Map([["error", shared]]))).toBeGreaterThan(workspaceSnapshotBytes(shared));
});

test("deleted canonical owners keep nested supporting changes in one indexed review group", () => {
  const root = fixtures.project(),
    owner = "workbench/decisions/01/ADR-0100.md",
    note = "workbench/decisions/01/ADR-0100/nested/evidence.txt";
  mkdirSync(join(root, "workbench/decisions/01/ADR-0100/nested"), { recursive: true });
  writeFileSync(join(root, owner), "# ADR-100: Nested decision\n\nKeep evidence together.\n");
  writeFileSync(join(root, note), "Original evidence.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Nested baseline");
  rmSync(join(root, owner));
  writeFileSync(join(root, note), "Revised evidence.\n");
  const index = new WorkspaceIndex(new WorkspaceCollector(root).collect());
  const view = index.select({});
  expect(view.reviewGroups).toHaveLength(1);
  const group = view.reviewGroups[0];
  expect(group?.path).toBe(owner);
  expect(group?.pending).toBe(2);
  expect(group?.changes.map((change) => change.path)).toEqual(expect.arrayContaining([owner, note]));
  for (const change of group?.changes ?? []) expect(index.reviewGroupByDigest.get(change.digest)).toBe(group);
  expect([...index.pendingReviewPaths]).toEqual([owner]);
  expect(view.pendingReviews).toBe(1);
});

test("Git index, included configuration, and ignore changes invalidate cached record discovery", () => {
  const root = fixtures.project(),
    collector = new WorkspaceCollector(root);
  writeFileSync(join(root, ".gitignore"), "workbench/decisions/ADR-01.md\n");
  writeFileSync(join(root, "workbench/decisions/ADR-01.md"), "# ADR-1: Initially ignored\n");
  const ignored = collector.collect();
  expect(ignored.review.changes.some((change) => change.path.endsWith("ADR-01.md"))).toBe(false);
  git(root, "add", "-f", "workbench/decisions/ADR-01.md");
  const indexed = collector.collect();
  expect(indexed).not.toBe(ignored);
  expect(indexed.review.changes.some((change) => change.path.endsWith("ADR-01.md"))).toBe(true);
  const included = join(root, ".git/extra-config");
  writeFileSync(included, "[core]\n  filemode = true\n");
  git(root, "config", "include.path", included);
  const configured = collector.collect();
  writeFileSync(included, "[core]\n  filemode = false\n");
  expect(collector.collect()).not.toBe(configured);
  const beforeIgnore = collector.collect();
  writeFileSync(join(root, ".gitignore"), "workbench/decisions/ADR-02.md\n");
  expect(collector.collect()).not.toBe(beforeIgnore);
});
