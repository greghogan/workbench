import { expect, test, vi } from "vitest";
import fc from "fast-check";
import MarkdownIt from "markdown-it";
import { parseDOM } from "../../fixtures/dom.mjs";
import { alignBlocks } from "../../../src/server/review/block-alignment.ts";
import { compareDocuments, reviewAnnotations } from "../../../src/server/review/document-comparison.ts";
import { prepareDocumentComparison } from "../../../src/server/review/document-comparison-model.ts";
import { diffWordsWithSpace } from "diff";

vi.mock("diff", async (original) => {
  const actual = await original<typeof import("diff")>();
  return { ...actual, diffWordsWithSpace: vi.fn(actual.diffWordsWithSpace) };
});
const budget = () => ({ now: () => 0, milliseconds: 60, maxEdits: 2048 });
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
function semantics(html: string, side?: "previous" | "current") {
  const body = parseDOM(html).window.document.body;
  if (side)
    for (const node of body.querySelectorAll(`${side === "previous" ? "ins" : "del"},.diff-separator`)) {
      const code = node.closest("pre");
      node.remove();
      if (code && !code.textContent) code.remove();
    }
  const code = [...body.querySelectorAll("pre")].map((node) => node.textContent);
  for (const node of body.querySelectorAll("pre")) node.remove();
  for (const node of body.querySelectorAll("p,li,blockquote,h1,h2,h3")) node.append(" ");
  return { text: normalize(body.textContent), code };
}
test.each([false, true])(
  "list spacing preserves both presentations without replacing unchanged items (%s)",
  (reverse) => {
    const tight = "- [x] Preserve work.\n- [x] Verify recovery.\n- [x] Retain evidence.\n";
    const loose = tight.replace("- [x] Retain", "\n- [x] Retain");
    const [before, after] = reverse ? [loose, tight] : [tight, loose];
    const parser = new MarkdownIt({ html: false });
    reviewAnnotations(parser);
    const compared = compareDocuments(before, after, undefined, { parser, budget: budget() });
    expect(compared.changed).toBe(false);
    for (const [side, source] of [
      ["previous", before],
      ["current", after],
    ] as const)
      expect(
        parser.renderer.render(
          compared.rows.flatMap((row) => row[side]),
          parser.options,
          {},
        ),
      ).toBe(parser.render(source));

    const revised = after.replace("Verify recovery.", "Verify restart recovery.");
    const changed = compareDocuments(before, revised, undefined, { parser, budget: budget() });
    expect(changed.changed).toBe(true);
    for (const [side, source] of [
      ["previous", before],
      ["current", revised],
    ] as const) {
      const html = parser.renderer.render(
        changed.rows.flatMap((row) => row[side]),
        parser.options,
        {},
      );
      expect(semantics(html, side)).toEqual(semantics(parser.render(source)));
      expect(parseDOM(html).window.document.querySelectorAll("li p")).toHaveLength(
        parseDOM(parser.render(source)).window.document.querySelectorAll("li p").length,
      );
    }
  },
);
test.each([
  ["", "```mermaid\nflowchart LR\n  A --> B\n```\n"],
  ["```mermaid\nflowchart LR\n  A --> B\n```\n", ""],
  ["> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n", "> ```mermaid\n> flowchart LR\n>   A --> C\n> ```\n"],
  ["```mermaid\nflowchart LR\n  A --> B\n```\n", "A diagram was replaced by prose.\n"],
])("diagram comparisons preserve both literal versions through insertion, removal, and nesting", (before, after) => {
  const parser = new MarkdownIt({ html: false });
  reviewAnnotations(parser);
  const comparison = compareDocuments(before, after, undefined, { parser, budget: budget() });
  for (const [side, source] of [
    ["previous", before],
    ["current", after],
  ] as const)
    for (const layout of [side, "unified"] as const)
      expect(
        semantics(
          parser.renderer.render(
            comparison.rows.flatMap((row) => row[layout]),
            parser.options,
            {},
          ),
          side,
        ),
      ).toEqual(semantics(parser.render(source)));
});
test("generated edit, insertion, deletion and reflow combinations reconstruct both documents including literal code", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          words: fc.array(fc.constantFrom("alpha", "bravo", "café", "日本語", "delta"), {
            minLength: 3,
            maxLength: 12,
          }),
          change: fc.constantFrom("same", "edit", "delete", "insert"),
          wrap: fc.boolean(),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (paragraphs) => {
        const before =
          paragraphs.map((part, index) => `Topic ${String(index)}. ${part.words.join(" ")}.`).join("\n\n") +
          "\n\n```text\n  literal  spacing\n\tcode\n```\n";
        const after =
          paragraphs
            .flatMap((part, index) => {
              if (part.change === "delete") return [];
              const words: string[] = [...part.words];
              if (part.change === "edit") words[1] = "revised";
              const text = `Topic ${String(index)}. ${words.join(part.wrap ? "\n" : " ")}.`;
              return part.change === "insert" ? [`Unrelated inserted paragraph ${String(index)}.`, text] : [text];
            })
            .join("\n\n") + "\n\n```text\n literal   spacing\n\tcode\n```\n";
        const parser = new MarkdownIt({ html: false });
        reviewAnnotations(parser);
        const comparison = compareDocuments(before, after, undefined, { budget: budget(), parser });
        for (const [side, source] of [
          ["previous", before],
          ["current", after],
        ] as const) {
          const expected = semantics(parser.render(source));
          for (const layout of [side, "unified"] as const) {
            const actual = parser.renderer.render(
              comparison.rows.flatMap((row) => row[layout]),
              parser.options,
              {},
            );
            expect(semantics(actual, side)).toEqual(expected);
          }
        }
      },
    ),
    { numRuns: 80 },
  );
});
test("bounded alignment agrees with exhaustive monotone paths on small generated score matrices", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 0, max: 4 }),
      fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 16, maxLength: 16 }),
      (n, m, scores) => {
        const before = Array.from({ length: n }, (_, i) => i),
          after = Array.from({ length: m }, (_, i) => i);
        const score = (i: number, j: number) => (scores[i * 4 + j] ?? 0) / 10;
        const totals: number[] = [];
        function enumerate(i: number, j: number, cost: number): void {
          if (i === n && j === m) {
            totals.push(cost);
            return;
          }
          if (i < n) enumerate(i + 1, j, cost + 1);
          if (j < m) enumerate(i, j + 1, cost + 1);
          if (i < n && j < m && score(i, j) >= 0.35) enumerate(i + 1, j + 1, cost + 3 * (1 - score(i, j)));
        }
        enumerate(0, 0, 0);
        const paired = alignBlocks(before, after, score, { maxCells: 25, available: () => true });
        expect(paired).toBeDefined();
        expect(paired?.flatMap(([old]) => (old === undefined ? [] : [old]))).toEqual(before);
        expect(paired?.flatMap(([, next]) => (next === undefined ? [] : [next]))).toEqual(after);
        const actual = paired?.reduce(
          (sum, [old, next]) => sum + (old === undefined || next === undefined ? 1 : 3 * (1 - score(old, next))),
          0,
        );
        expect(actual).toBeCloseTo(Math.min(...totals), 10);
      },
    ),
    { numRuns: 150 },
  );
});
test("ordered wording distinguishes an inserted reversal from the revised paragraph", () => {
  const parser = new MarkdownIt();
  reviewAnnotations(parser);
  const compared = compareDocuments(
    "alpha bravo charlie delta old.\n",
    "delta charlie bravo alpha new.\n\nalpha bravo charlie delta new.\n",
    undefined,
    { budget: budget() },
  );
  const rows = compared.rows.filter((row) => row.changed);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.previous).toHaveLength(0);
  expect(semantics(parser.renderer.render(rows[1]?.previous ?? [], parser.options, {})).text).toBe(
    "alpha bravo charlie delta old.",
  );
  expect(semantics(parser.renderer.render(rows[1]?.current ?? [], parser.options, {})).text).toBe(
    "alpha bravo charlie delta new.",
  );
});
test("metadata fields share the body's allowance and preserve complete values after it is exhausted", () => {
  let now = 0;
  const actual = vi.mocked(diffWordsWithSpace).getMockImplementation();
  if (!actual) throw new Error("Missing real word diff implementation");
  vi.mocked(diffWordsWithSpace).mockImplementationOnce((...args) => {
    const result = actual(...args);
    now = 100;
    return result;
  });
  const before = "---\na: several old words\nb: several old words\nc: several old words\n---\nUnchanged body.\n";
  const after = before.replaceAll("old", "new");
  const result = prepareDocumentComparison({ before, after, patch: "" }, undefined, undefined, {
    now: () => now,
    milliseconds: 60,
    maxEdits: 2048,
  });
  expect(result.rows[0]?.parts).toContainEqual({ change: "removed", text: "old" });
  for (const row of result.rows.slice(1))
    expect(row.parts).toEqual([
      { change: "removed", text: "several old words" },
      { change: "added", text: "several new words" },
    ]);
  expect(result.compared.changed).toBe(false);
  const exhausted = prepareDocumentComparison({ before, after, patch: "" }, undefined, undefined, {
    now: () => 0,
    milliseconds: 0,
    maxEdits: 2048,
  });
  expect(exhausted.compared.changed).toBe(false);
  for (const row of exhausted.rows)
    expect(row.parts).toEqual([
      { change: "removed", text: "several old words" },
      { change: "added", text: "several new words" },
    ]);
});

test("alignment distinguishes exhausted work from invalid input without inventing pairs", () => {
  const score = vi.fn(() => 1);
  expect(alignBlocks(["old"], ["new"], score, { available: () => false, maxCells: 4 })).toBeUndefined();
  expect(score).not.toHaveBeenCalled();
  expect(alignBlocks(["old"], ["new"], score, { available: () => true, maxCells: 3 })).toBeUndefined();
  expect(score).not.toHaveBeenCalled();
  expect(() => alignBlocks([undefined], ["new"], score, { available: () => true, maxCells: 4 })).toThrow(
    /dense input sequences/,
  );
});
