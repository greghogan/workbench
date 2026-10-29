import { resolve } from "node:path";
import { expect, test } from "vitest";
import { RecordLookup } from "../src/record-lookup.js";
import type { BrowserRecord } from "../src/record-service.js";

const record = (directory: string, id: string, path: string, type: BrowserRecord["type"] = "ADR"): BrowserRecord => ({
  id,
  directory,
  path,
  type,
  scope: id.split(":")[0] ?? "",
  title: id,
  summary: "",
  status: "",
  editable: false,
  collection: false,
  local: false,
});
test("reference lookups distinguish identical paths in separate collection directories and fold record IDs", () => {
  const first = record(resolve("owned"), "first:ADR-0", "workbench/decisions/ADR-00.md");
  const second = record(resolve("local"), "second:ADR-0", first.path);
  const lookup = new RecordLookup([first, second]);
  expect(lookup.record("FIRST:adr-0")).toBe(first);
  expect(lookup.record("first:ADR-1")).toBeUndefined();
  expect(lookup.path(resolve(first.directory, first.path))).toBe(first);
  expect(lookup.path(resolve(second.directory, second.path))).toBe(second);
  expect(lookup.owner(resolve(second.directory, "workbench/decisions/ADR-00/evidence.txt"))).toBe(second);
  expect(lookup.owner(resolve(first.directory, "workbench/decisions/ADR-00-other/evidence.txt"))).toBeUndefined();
  expect(lookup.owner(resolve(first.directory, "workbench/decisions/ADR-00"))).toBeUndefined();
  expect(lookup.owner(resolve(first.directory, "workbench/decisions/ADR-00/../outside.txt"))).toBeUndefined();
});
test("supporting-file ownership preserves record order for nested roots and excludes charters", () => {
  const parent = record(resolve("owned"), "first:ADR-0", "records/ADR-00.md");
  const child = record(parent.directory, "first:ADR-1", "records/ADR-00/ADR-01.md");
  const charter = record(parent.directory, "first:CHARTER", "CHARTER.md", "CHARTER");
  const path = resolve(parent.directory, "records/ADR-00/ADR-01/fixture.txt");
  expect(new RecordLookup([parent, child]).owner(path)).toBe(parent);
  expect(new RecordLookup([child, parent]).owner(path)).toBe(child);
  expect(new RecordLookup([charter]).owner(resolve(parent.directory, "CHARTER/fixture.txt"))).toBeUndefined();
});
