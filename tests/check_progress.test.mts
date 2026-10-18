import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CheckLines, CheckProgress } from "../src/check-progress.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function screen(interactive = true, columns = 80, rows = 24) {
  let now = 0;
  const chunks: string[] = [];
  const lines: string[] = [];
  let row = 0,
    column = 0;
  const output = {
    isTTY: interactive,
    columns,
    rows,
    write(text: string) {
      chunks.push(text);
      for (const token of text.replaceAll("\u001b", "\ufffc").match(/\ufffc\[\d+A|\ufffc\[0J|\r|\n|[^\ufffc\r\n]+/g) ??
        []) {
        if (token.startsWith("\ufffc[") && token.endsWith("A")) row -= Number(token.slice(2, -1));
        else if (token === "\ufffc[0J") {
          lines.splice(row);
          column = 0;
        } else if (token === "\r") column = 0;
        else if (token === "\n") {
          row++;
          column = 0;
        } else {
          const previous = lines[row] ?? "";
          lines[row] = previous.slice(0, column) + token + previous.slice(column + token.length);
          column += token.length;
        }
        expect(row).toBeGreaterThanOrEqual(0);
      }
    },
  };
  return {
    chunks,
    lines,
    output,
    progress: new CheckProgress(3, output, () => now),
    advance: (milliseconds: number) => {
      now += milliseconds;
      vi.advanceTimersByTime(milliseconds);
    },
  };
}

test("interactive progress replaces active rows without erasing earlier output", () => {
  const { lines, progress } = screen();
  progress.message("Earlier validation passed.");
  progress.startGroup("a", "Python");
  progress.startGroup("b", "Rust");
  progress.event("a", "Python", 1, "lint", "start");
  progress.event("b", "Rust", 1, "coverage", "start");
  expect(lines.join("\n")).toContain("Python: lint");
  expect(lines.join("\n")).toContain("Rust: coverage");
  progress.event("a", "Python", 1, "lint", "pass");
  progress.finishGroup("a", "Python", false);
  expect(lines.join("\n")).toContain("Passed Python: lint (0.0s)");
  expect(lines.slice(lines.findIndex((line) => line.includes("1/3 checks completed"))).join("\n")).not.toContain(
    "Python:",
  );
  expect(lines.join("\n")).toContain("Rust: coverage");
  progress.event("b", "Rust", 1, "coverage", "pass");
  progress.event("b", "Rust", 2, "docs", "pass");
  progress.finishGroup("b", "Rust", false);
  progress.close(true);
  expect(lines.filter(Boolean)).toEqual([
    "Earlier validation passed.",
    "[1/3 completed] Passed Python: lint (0.0s)",
    "[2/3 completed] Passed Rust: coverage (0.0s)",
    "[3/3 completed] Passed Rust: docs (0.0s)",
    "Passed 3/3 checks in 0.0s.",
  ]);
});

test("redirected output prints lifecycle events once without terminal cursor controls", () => {
  const { chunks, progress } = screen(false, 200);
  progress.startGroup("a", "Python");
  progress.event("a", "Python", 1, "test", "start");
  progress.event("a", "Python", 1, "test", "pass");
  progress.event("a", "Python", 1, "test", "pass");
  progress.finishGroup("a", "Python", false);
  progress.close(true);
  expect(chunks.join("")).not.toContain("\u001b");
  expect(progress.completed).toBe(1);
  expect(chunks.join("").match(/Passed Python: test/g)).toHaveLength(1);
  expect(chunks.join("")).toContain("Starting Python");
  expect(chunks.join("")).toContain("Completed Python");
});

test("narrow terminals clip labels and sanitize external controls before redraw", () => {
  const { chunks, progress } = screen(true, 24);
  progress.startGroup("a", "Long label " + "é".repeat(100) + "\u001b[2J");
  progress.event("a", "Python", 1, "test", "fail");
  progress.stop();
  progress.finishGroup("a", "Python", true);
  progress.close(false);
  expect(chunks.join("")).not.toContain("\u001b[2J");
  for (const chunk of chunks.filter((text) => /^\d+\/\d+ checks completed/.test(text)))
    for (const line of chunk.trimEnd().split("\n")) expect(Buffer.byteLength(line)).toBeLessThan(24);
});

test("diagnostic output temporarily removes the tracker and restores pending updates", () => {
  const { lines, progress } = screen();
  progress.startGroup("a", "Python");
  progress.suspend();
  progress.message("Deferred diagnostic");
  progress.event("a", "Python", 1, "test", "pass");
  expect(lines.filter(Boolean)).toEqual([]);
  progress.resume();
  expect(lines[0]).toBe("Deferred diagnostic");
  expect(lines.join("\n")).toContain("1/3 checks completed");
  progress.finishGroup("a", "Python", false);
  progress.close(false);
});

test("line decoding preserves UTF-8 boundaries and recovers after an oversized diagnostic", () => {
  const lines: string[] = [];
  const decoder = new CheckLines((line) => lines.push(line));
  const bytes = Buffer.from(
    "héllo\nWORKBENCH_CHECK_EVENT\tstart\t1\n" + "x".repeat(70000) + "\nWORKBENCH_CHECK_EVENT\tpass\t1\nlast",
  );
  for (let index = 0; index < bytes.length; index += 3) decoder.push(bytes.subarray(index, index + 3));
  decoder.end();
  expect(lines).toEqual(["héllo", "WORKBENCH_CHECK_EVENT\tstart\t1", "WORKBENCH_CHECK_EVENT\tpass\t1", "last"]);
});

test("verbose decoding preserves oversized diagnostics without unbounded line buffering", () => {
  const ordinary: string[] = [],
    oversized: string[] = [];
  const decoder = new CheckLines(
    (line) => ordinary.push(line),
    (part) => oversized.push(part),
  );
  const text = "é".repeat(70000) + "\n";
  const bytes = Buffer.from(text + "next\n");
  for (let index = 0; index < bytes.length; index += 4096) decoder.push(bytes.subarray(index, index + 4096));
  decoder.end();
  expect(oversized.join("")).toBe(text);
  expect(ordinary).toEqual(["next"]);
});

test("a terminal with unknown dimensions uses readable fallback dimensions", () => {
  const { chunks, progress } = screen(true, 0);
  progress.startGroup("a", "Python");
  expect(chunks.join("")).toContain("Python: preparing / finishing session");
  progress.finishGroup("a", "Python", false);
  progress.close(false);
});

test("active runtimes refresh while completed task durations remain fixed in scrollback", () => {
  const { lines, chunks, progress, advance } = screen(true, 120);
  progress.startGroup("a", "Python");
  progress.event("a", "Python", 1, "lint", "start");
  advance(1250);
  expect(lines.join("\n")).toContain("Python: lint [1.3s]");
  progress.event("a", "Python", 1, "lint", "pass");
  progress.event("a", "Python", 2, "test", "start");
  advance(2000);
  expect(lines.join("\n")).toContain("Passed Python: lint (1.3s)");
  expect(lines.join("\n")).toContain("Python: test [2.0s]");
  expect(chunks.join("").match(/Passed Python: lint/g)).toHaveLength(1);
  progress.event("a", "Python", 2, "test", "pass");
  progress.finishGroup("a", "Python", false);
  expect(vi.getTimerCount()).toBe(0);
  progress.close(true);
  const closed = chunks.join("");
  advance(1000);
  progress.close(true);
  expect(chunks.join("")).toBe(closed);
});

test.each([1, 2, 3, 5])("the active pane stays within a %s-row viewport", (rows) => {
  const { chunks, progress, advance } = screen(true, 32, rows);
  for (const id of ["a", "b", "c", "d"]) progress.startGroup(id, "Very long language label");
  advance(1000);
  for (const chunk of chunks.filter((value) => !value.startsWith("\u001b"))) {
    expect(chunk.trimEnd().split("\n").length).toBeLessThanOrEqual(Math.max(1, rows - 1));
    for (const line of chunk.trimEnd().split("\n")) expect(Buffer.byteLength(line)).toBeLessThan(32);
  }
  progress.stop();
  progress.close(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("plain progress has fixed completed runtimes and no refresh timer", () => {
  const { chunks, progress, advance } = screen(false);
  progress.startGroup("a", "Python");
  progress.event("a", "Python", 1, "test", "start");
  advance(65000);
  progress.event("a", "Python", 1, "test", "pass");
  progress.finishGroup("a", "Python", false);
  progress.close(true);
  expect(chunks.join("")).toContain("Passed Python: test (1m 05s)");
  expect(vi.getTimerCount()).toBe(0);
  expect(chunks.join("")).not.toContain("\u001b");
});

test("cancelled groups are reported without claiming completion or failure", () => {
  const { chunks, progress } = screen(false);
  progress.startGroup("a", "Python");
  progress.stop();
  progress.finishGroup("a", "Python", "cancelled");
  progress.close(false);
  expect(chunks.join("")).toContain("Cancelled Python");
  expect(chunks.join("")).not.toContain("Completed Python");
  expect(chunks.join("")).not.toContain("Failed Python");
  expect(progress.completed).toBe(0);
});
