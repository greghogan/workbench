import { required } from "../src/invariants.ts";
import { expect, test } from "vitest";
import { terminalTable } from "../src/terminal-table.ts";
import { fitTerminalText, terminalColumns, minimumTerminalWidth, wrapTerminalText } from "../src/terminal-text.ts";
import fc from "fast-check";

test("Unicode tables wrap whole graphemes and align by display cells", () => {
  expect(terminalTable(["A"], [["雪e\u0301👩‍💻Z"]], { maxWidths: { 0: 3 } }).split("\n")).toEqual([
    "+-----+",
    "| A   |",
    "+-----+",
    "| 雪e\u0301 |",
    "| 👩‍💻Z |",
    "+-----+",
  ]);
  expect(terminalTable(["X"], [["雪"]], { maxWidths: { 0: 1 } })).toContain("| 雪 |");
  expect(terminalColumns("e\u0301雪👩‍💻")).toBe(5);
  expect(fitTerminalText("e\u0301雪👩‍💻", 3)).toBe("e\u0301雪");
  expect(fitTerminalText("e\u0301雪👩‍💻", 5)).toBe("e\u0301雪👩‍💻");
});

test("wrapping preserves combining characters beside spaces without shifting later graphemes", () => {
  expect(wrapTerminalText("e\u0301\t\u0301界👩‍💻\t界", 2)).toEqual(["e\u0301 \u0301", "界", "👩‍💻", " ", "界"]);
  expect(wrapTerminalText("", 2)).toEqual([""]);
  expect(wrapTerminalText("雪", 1)).toEqual(["雪"]);
});

test("hard wrapping preserves exact text and bounds each line's display cells", () => {
  const fragment = fc.constantFrom("a", " ", "雪", "e\u0301", "\u0301", "👩‍💻", "🇯🇵", "\u200b", "क्", "ष");
  fc.assert(
    fc.property(fc.array(fragment, { maxLength: 40 }), fc.integer({ min: 1, max: 30 }), (parts, columns) => {
      const text = parts.join("");
      const limit = Math.max(columns, minimumTerminalWidth(text));
      const lines = wrapTerminalText(text, limit);
      expect(lines.join("")).toBe(text);
      expect(lines.every((line) => terminalColumns(line) <= limit)).toBe(true);
    }),
    { numRuns: 200, seed: 20261104 },
  );
});

test("tables sanitize control characters and render empty tables without duplicate closing rules", () => {
  expect(terminalTable(["LABEL"], [["a\nb\u001b"]])).toContain("a b ");
  expect(terminalTable(["LABEL"], [])).toBe("+-------+\n| LABEL |\n+-------+");
});

test("quantity columns align numbers right and units left with one separating space", () => {
  const table = terminalTable(
    ["NAME", "QUANTITY"],
    [
      ["first", "999 B"],
      ["second", "1.0 kB"],
      ["third", "12.5 MB"],
    ],
    { quantities: [1] },
  );
  const cells = table
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("QUANTITY"))
    .map((line) => line.split("|")[2]);
  const positions = cells.map((cell) => {
    const match = /(\d+(?:\.\d+)?) (B|kB|MB)\s*$/.exec(required(cell, "Expected fixture value"));
    expect(match).not.toBeNull();
    return (
      required(match, "Expected fixture value: match").index +
      required(required(match, "Expected fixture value: match")[1], "Expected fixture value: match[1]").length
    );
  });
  expect(new Set(positions).size).toBe(1);
  expect(
    cells.every(
      (cell) =>
        required(cell, "Expected fixture value: cell").length ===
        required(cells[0], "Expected fixture value: cells[0]").length,
    ),
  ).toBe(true);
});

test("bounded columns wrap complete content and keep adjacent cells and row separators aligned", () => {
  const lines = terminalTable(
    ["NAME", "VALUE"],
    [
      ["first", "0123456789ABC"],
      ["second", "xy"],
    ],
    {
      maxWidths: { 1: 5 },
      separators: [{ after: 0 }],
    },
  ).split("\n");
  expect(lines).toEqual([
    "+--------+-------+",
    "| NAME   | VALUE |",
    "+--------+-------+",
    "| first  | 01234 |",
    "|        | 56789 |",
    "|        | ABC   |",
    "+--------+-------+",
    "| second | xy    |",
    "+--------+-------+",
  ]);
  expect(terminalTable(["HEADER"], [["content"]], { maxWidths: { 0: 0 } })).toContain("| HEADER |");
});

test("partial subtotal rules leave preceding columns open and full rules separate groups", () => {
  const lines = terminalTable(
    ["CHECKOUT", "ROOT", "SIZE"],
    [
      ["/first", ".", "1 B"],
      ["", "total", "1 B"],
      ["/second", ".", "2 B"],
    ],
    {
      separators: [{ after: 1 }, { after: 0, from: 1 }, { after: 2 }],
    },
  ).split("\n");
  const checkoutEnd = required(lines[1], "Expected fixture value: lines[1]").indexOf("|", 1);
  expect(lines[4]).toBe(
    `|${" ".repeat(checkoutEnd - 1)}${required(lines[0], "Expected fixture value: lines[0]").slice(checkoutEnd)}`,
  );
  expect(lines[6]).toBe(lines[0]);
  expect(lines.at(-1)).toBe(lines[0]);
  expect(lines.at(-2)).toContain("/second");
});
