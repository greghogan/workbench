import { recordBatchSize } from "../../../src/server/routes/record-window.ts";
import { expect, test } from "vitest";
import { recordBatch } from "../../../src/server/routes/record-listing.ts";
import type { BrowserRecord } from "../../../src/core/records/record-service.ts";

test("mixed numeric tasks and named plans keep stable forward and backward record windows", () => {
  const count = recordBatchSize + 1,
    width = String(count).length,
    numeric = Array.from({ length: count }, (_, number) => `demo:TSK-${number.toString(36).toUpperCase()}`),
    planned = Array.from({ length: count }, (_, number) => `demo:plan/idea-${String(number).padStart(width, "0")}`),
    expected = [...numeric, ...planned],
    records: BrowserRecord[] = [...expected].reverse().map((id) => ({
      id,
      type: "TSK",
      scope: "demo",
      title: id,
      summary: "",
      status: "Planned",
      path: id,
      directory: "/fixture",
      editable: false,
      local: false,
      collection: false,
    })),
    pages: string[][] = [];
  let after: string | null = null;
  for (;;) {
    const page = recordBatch(records, after, null),
      ids = page.visible.map((record) => record.id);
    pages.push(ids);
    if (!page.more) break;
    const next = ids.at(-1);
    if (!next || next === after) throw new Error("Record traversal made no progress");
    after = next;
  }
  expect(pages.flat()).toEqual(expected);
  const second = pages[1]?.[0];
  if (!second) throw new Error("Expected a second record window");
  expect(recordBatch(records, null, null, second).visible.map((record) => record.id)).toEqual(pages[0]);
  const lastNumeric = numeric.at(-1);
  if (!lastNumeric) throw new Error("Missing numeric boundary");
  expect(recordBatch(records, lastNumeric, null).visible[0]?.id).toBe(planned[0]);
});
