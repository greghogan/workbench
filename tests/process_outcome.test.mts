import { describeError } from "../scripts/diagnostics.mjs";
import { expect, test } from "vitest";
import { processFailure } from "../scripts/process-outcome.mjs";
import { assertProcessSuccess, completedProcess } from "./fixtures/process.mjs";

test("normal process success produces no failure", () => {
  const result = completedProcess();
  expect(processFailure("fixture", result)).toBeUndefined();
  expect(() => {
    assertProcessSuccess("fixture", result);
  }).not.toThrow();
});

test.each([
  { status: 7, signal: null, label: "exit code" },
  { status: null, signal: "SIGTERM" as const, label: "signal" },
  { status: null, signal: null, label: "unknown termination" },
])("process diagnostics retain PID and outcome for $label", ({ status, signal }) => {
  const failure = processFailure("coverage fixture", completedProcess({ pid: 123, status, signal }));
  expect(failure?.message).toContain("coverage fixture failed");
  expect(failure?.message).toContain("pid=123");
  expect(failure?.message).toContain(`status=${String(status)}`);
  expect(failure?.message).toContain(`signal=${String(signal)}`);
});

test("spawn failures retain their original error and OS error code", () => {
  const cause = Object.assign(new Error("could not launch fixture"), { code: "EAGAIN" });
  const result = completedProcess({ pid: 0, status: null, error: cause });
  const failure = processFailure("fixture", result);
  expect(failure?.cause).toBe(cause);
  expect(describeError(failure)).toContain("EAGAIN");
  expect(describeError(failure)).toContain("could not launch fixture");
  expect(() => {
    assertProcessSuccess("fixture", { ...result, stdout: null, stderr: null });
  }).toThrow("EAGAIN");
});

test("fixture diagnostics bound captured output and keep the useful tail", () => {
  const result = completedProcess({
    status: 9,
    stdout: "earlier output\n".repeat(2000),
    stderr: "actual failure cause",
  });
  let failure: unknown;
  try {
    assertProcessSuccess("fixture", result);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected failed child assertion");
  expect(failure.message).toContain("Earlier child output omitted.");
  expect(failure.message).toContain("actual failure cause");
  expect(failure.message).toContain("status=9");
  expect(Buffer.byteLength(failure.message)).toBeLessThan(8500);
  expect(failure.cause).toBeInstanceOf(Error);
});
