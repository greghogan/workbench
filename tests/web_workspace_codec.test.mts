import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspaceCollector, WorkspaceIndex } from "../src/workspace-service.ts";
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
