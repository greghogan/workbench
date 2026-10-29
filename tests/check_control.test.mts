import { expect, test } from "vitest";
import { CheckControl, checkControlPrefix } from "../src/check-control.ts";
import { required } from "../src/invariants.ts";

const token = "a".repeat(32);
const event = (name: string, step: string | number, owner = token) =>
  `${checkControlPrefix}${owner}\t${name}\t${String(step)}`;

test("private check control requires the owner token and a complete ordered command sequence", () => {
  const control = new CheckControl(token, 2);
  expect(control.accept("WORKBENCH_CHECK_EVENT\tpass\t1")).toBeUndefined();
  expect(control.accept(event("pass", 1, "b".repeat(32)))).toBeUndefined();
  expect(control.complete).toBe(false);
  for (const step of [1, 2]) {
    expect(control.accept(event("start", step))).toEqual({ event: "start", step });
    expect(control.complete).toBe(false);
    expect(control.accept(event("pass", step))).toEqual({ event: "pass", step });
  }
  expect(control.complete).toBe(true);
  expect(() => control.accept(event("pass", 2))).toThrow(/sequence/);
});

test.each(
  [
    [event("pass", 1)],
    [event("start", 2)],
    [event("start", "01")],
    [event("start", 1), event("start", 1)],
    [event("start", 1), event("pass", 2)],
    [event("start", 1), event("fail", 1), event("start", 2)],
    [event("start", 1), event("pass", 1), event("pass", 1)],
    [event("start", 1) + "\textra"],
  ].map((records) => [records] as const),
)("out-of-order or malformed private records fail closed: %j", (records) => {
  const control = new CheckControl(token, 2);
  for (const record of records.slice(0, -1)) control.accept(record);
  expect(() => control.accept(required(records.at(-1), "last control record"))).toThrow(/sequence/);
  expect(control.complete).toBe(false);
});

test("failed and incomplete control sequences never count as successful completion", () => {
  const control = new CheckControl(token, 1);
  control.accept(event("start", 1));
  expect(control.complete).toBe(false);
  expect(control.accept(event("fail", 1))).toEqual({ event: "fail", step: 1 });
  expect(control.complete).toBe(false);
  expect(() => new CheckControl("invalid", 1)).toThrow(/token/);
});
