import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { mergeAcknowledgments, readReviewReceipt, reviewChangeDigest } from "../src/review-service.ts";

test("receipt alternatives follow acknowledgment order even when clocks move backward, without mutating inputs", () => {
  const acknowledgment = (number: number, timestamp: string) => ({
    change: {
      path: "workbench/decisions/ADR-00.md",
      before: "100644:" + "a".repeat(40),
      after: "100644:" + String(number).repeat(40),
      charter: false,
    },
    approval: { head: "a".repeat(40), approved_at: timestamp, human_written_charter: false },
    latest: true,
  });
  const first = acknowledgment(1, "2030-01-01T00:00:00Z"),
    second = acknowledgment(2, "2029-01-01T00:00:00Z"),
    third = acknowledgment(3, "2028-01-01T00:00:00Z"),
    fourth = acknowledgment(4, "2027-01-01T00:00:00Z");
  const existing = new Map([
    [reviewChangeDigest(first.change), { ...first, latest: false }],
    [reviewChangeDigest(second.change), { ...second, latest: false }],
    [reviewChangeDigest(third.change), third],
  ]);
  const before = structuredClone(existing);
  const merged = JSON.parse(mergeAcknowledgments(existing, [fourth], fourth.approval.head)) as {
    changes: { after: string }[];
    alternatives: { change: { after: string } }[];
  };
  expect(merged.changes.map((change) => change.after)).toEqual([fourth.change.after]);
  expect(merged.alternatives.map(({ change }) => change.after)).toEqual([second.change.after, third.change.after]);
  expect(existing).toEqual(before);
});

test("review state distinguishes missing and malformed receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-review-receipt-"));
  const file = join(root, "review.json");
  try {
    expect(readReviewReceipt(file).state).toBe("missing");
    writeFileSync(file, "{}");
    const receipt = readReviewReceipt(file);
    expect(receipt).toMatchObject({ state: "invalid", problem: expect.any(Error) as unknown });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
