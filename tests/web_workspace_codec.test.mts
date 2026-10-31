import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspaceCollector, WorkspaceIndex, workspaceSnapshotBytes } from "../src/workspace-service.ts";
import { decodeWorkspaceSnapshot } from "../src/web/workspace-codec.ts";
import { webServers } from "./fixtures/web.mjs";

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
  Object.assign(document, { head: { state: "available", difference: { patch: [], paragraphs: {} } } });
  expect(() => decodeWorkspaceSnapshot(badDifference)).toThrow("invalid workspace worker snapshot");
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
