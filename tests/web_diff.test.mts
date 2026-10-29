import { renderToString } from "preact-render-to-string";
import { expect, test } from "vitest";
import { parseDOM } from "./fixtures/dom.mjs";
import { paragraphDifference } from "../src/web/paragraph-diff.ts";
import { diffView as difference, sourceDiffView as sourceDifference } from "../src/web/diff-view.js";
import { readFileSync } from "node:fs";

const diffView = (...args: Parameters<typeof difference>) => renderToString(difference(...args));
const sourceDiffView = (...args: Parameters<typeof sourceDifference>) => renderToString(sourceDifference(...args));

const scopeRewrite = JSON.parse(readFileSync(new URL("./fixtures/paragraph-diff.json", import.meta.url), "utf8")) as {
  before: string;
  after: string;
};

const parts = (before: string, after: string, change: "removed" | "added") =>
  paragraphDifference(before, after)
    .changes.flatMap((entry) => entry.parts)
    .filter((part) => part.change === change)
    .map((part) => part.text)
    .join("");

test.each([
  ["A paragraph with several words.\n", "A paragraph with\nseveral words.\n"],
  ["- Keep the selected tool and its version.\n", "- Keep the selected tool\n  and its version.\n"],
  ["> Keep the selected tool and its version.\n", "> Keep the selected tool\n> and its version.\n"],
  ["A naïve sentence with 日本語 and café.\n", "A naïve sentence with\n日本語 and café.\n"],
])("soft wrapping is not a paragraph or word change", (before, after) => {
  expect(paragraphDifference(before, after)).toMatchObject({ changes: [], formattingOnly: true, coarse: false });
});

test("only the changed words are highlighted when a paragraph is reflowed", () => {
  const before = "# Decision\n\nKeep the old implementation and its documented behavior.\n";
  const after = "# Decision\n\nKeep the new implementation\nand its documented behavior.\n";
  expect(parts(before, after, "removed")).toBe("old");
  expect(parts(before, after, "added")).toBe("new");
  expect(paragraphDifference(before, after).changes).toHaveLength(1);
});

test.each([
  ["Keep words together.\n", "Keep words  \ntogether.\n"],
  ["Keep words together.\n", "Keep words\n\ntogether.\n"],
  ["```text\none two\n```\n", "```text\none\ntwo\n```\n"],
  ["---\nvalue: |\n  one two\n---\n", "---\nvalue: |\n  one\n  two\n---\n"],
  ["- First item.\n- Second item.\n", "- First item.\n  - Second item.\n"],
])("meaningful Markdown and metadata structure remains visible", (before, after) => {
  const result = paragraphDifference(before, after);
  expect(result.formattingOnly).toBe(false);
  expect(result.changes.length).toBeGreaterThan(0);
});

test("paragraph additions, deletions, and unchanged documents have explicit outcomes", () => {
  expect(paragraphDifference("Same paragraph.\n", "Same paragraph.\n")).toEqual({
    changes: [],
    formattingOnly: false,
    coarse: false,
  });
  expect(paragraphDifference("", "New paragraph.\n").changes[0]).toMatchObject({
    before: null,
    after: "New paragraph.",
  });
  expect(paragraphDifference("Old paragraph.\n", "").changes[0]).toMatchObject({
    before: "Old paragraph.",
    after: null,
  });
});

test("inline rendering escapes active content and conveys additions and removals without color", () => {
  const paragraphs = paragraphDifference("Keep old <script>.\n", "Keep new <script>.\n"),
    html = sourceDiffView({ patch: "", paragraphs });
  const dom = parseDOM(html);
  expect(dom.window.document.querySelector("script")).toBeNull();
  expect(dom.window.document.querySelector(".diff-content del")?.textContent).toBe("old");
  expect(dom.window.document.querySelector(".diff-content ins")?.textContent).toBe("new");
  expect(dom.window.document.querySelector(".diff-paragraph")?.getAttribute("aria-label")).toBe("Changed paragraph");
  expect(dom.window.document.querySelectorAll(".diff-content")).toHaveLength(1);
  expect(dom.window.document.querySelectorAll(".diff-legend,.diff-change-label")).toHaveLength(0);
  expect(projection(dom.window.document.querySelector(".diff-content"), "before")).toBe("Keep old <script>.");
  expect(projection(dom.window.document.querySelector(".diff-content"), "after")).toBe("Keep new <script>.");
  dom.window.close();
});

function projection(element: Element | undefined | null, side: "before" | "after"): string {
  if (!element) throw new Error("Missing diff paragraph");
  const copy = element.cloneNode(true) as Element;
  for (const node of copy.querySelectorAll(`${side === "before" ? "ins" : "del"},.diff-separator`)) node.remove();
  return copy.textContent;
}

test("a rewritten decision consolidates fragmented edits into one removal followed by one addition", () => {
  const difference = paragraphDifference(scopeRewrite.before, scopeRewrite.after);
  const dom = parseDOM(sourceDiffView({ patch: "", paragraphs: difference }));
  try {
    const document = dom.window.document;
    const paragraph = document.querySelector(".diff-content");
    expect(document.querySelectorAll(".diff-content")).toHaveLength(1);
    expect(projection(paragraph, "before")).toBe(scopeRewrite.before.trim().replace(/\n/g, " "));
    expect(projection(paragraph, "after")).toBe(scopeRewrite.after.trim().replace(/\n/g, " "));
    expect([...(paragraph?.querySelectorAll("del,ins") ?? [])].map((node) => node.tagName)).toEqual(["DEL", "INS"]);
    expect(document.querySelectorAll(".diff-content .sr-only")).toHaveLength(0);
  } finally {
    dom.window.close();
  }
});

test.each([
  ["---\nvalue: |\n  one two\n---\n", "---\nvalue: |\n    one\n    two\n---\n"],
  ["```text\n\tone two\n```\n", "```text\n\t one\ttwo\n```\n"],
  ["A naïve sentence with 日本語 and café.\n", "A revised naïve sentence with\n日本語 and café!\n"],
  ["One old paragraph.\n\nA second old paragraph.\n", "One new paragraph.\n\nA second new paragraph.\n"],
  ["Keep words together.\n", "Keep words\n\ntogether.\n"],
  ["A\n\nB\n", "B\n\nA\n"],
])("rendered versions preserve complete text and literal whitespace across structural changes", (before, after) => {
  const difference = paragraphDifference(before, after);
  const dom = parseDOM(sourceDiffView({ patch: "", paragraphs: difference }));
  try {
    for (const [index, change] of difference.changes.entries()) {
      const paragraph = dom.window.document.querySelectorAll(".diff-paragraph")[index];
      expect(projection(paragraph?.querySelector(".diff-content"), "before")).toBe(change.before ?? "");
      expect(projection(paragraph?.querySelector(".diff-content"), "after")).toBe(change.after ?? "");
    }
  } finally {
    dom.window.close();
  }
});

test("single-file source views omit Git file headers and retain hunk positions", () => {
  const patch =
    "diff --git a/ADR.md b/ADR.md\nindex 1234567..abcdef1 100644\n--- a/ADR.md\n+++ b/ADR.md\n@@ -1 +1 @@\n-old\n+new\n";
  for (const split of [false, true]) {
    const html = diffView(patch, split);
    expect(html).not.toContain("diff --git");
    expect(html).not.toContain("index 123");
    expect(html).not.toContain("--- a/");
    expect(html).not.toContain("+++ b/");
    expect(html).toContain("@@ -1,1 +1,1 @@");
  }
});

test("file permissions remain visible when contents are unchanged", () => {
  const patch = "diff --git a/ADR.md b/ADR.md\nold mode 100644\nnew mode 100755\n";
  const html = sourceDiffView({ patch, paragraphs: paragraphDifference("Same text.\n", "Same text.\n") });
  expect(html).toContain("File mode: 100644 → 100755");
  expect(html).toContain("File contents unchanged.");
  expect(html).not.toContain("diff --git");
});

test("the existing frontmatter format retains comments and exact literal whitespace", () => {
  const before = "---\n# Old comment\nvalue: |\n  text\n---\n\nA paragraph.\n";
  const after = "---\n# New comment\nvalue: |\n    text\n---\n\nA\nparagraph.\n";
  const result = paragraphDifference(before, after);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]?.section).toBe("Metadata");
  expect(result.changes[0]?.before).toContain("# Old comment");
  expect(result.changes[0]?.after).toContain("# New comment");
  const document = parseDOM(sourceDiffView({ patch: "", paragraphs: result })).window.document;
  const paragraph = document.querySelector(".diff-content");
  expect(projection(paragraph, "before")).toBe(result.changes[0]?.before);
  expect(projection(paragraph, "after")).toBe(result.changes[0]?.after);
});

test("whitespace-only literal edits remain visible without altering their copied bytes", () => {
  const before = "---\nvalue: |\n  text\n---\n",
    after = "---\nvalue: |\n    text\n---\n";
  const difference = paragraphDifference(before, after);
  const document = parseDOM(sourceDiffView({ patch: "", paragraphs: difference })).window.document;
  const paragraph = document.querySelector(".diff-content");
  expect(paragraph?.querySelector('[title="Whitespace change"]')).not.toBeNull();
  expect(projection(paragraph, "before")).toBe(before.trimEnd());
  expect(projection(paragraph, "after")).toBe(after.trimEnd());
});

test("an exhausted word comparison budget retains exact source projections", () => {
  let calls = 0;
  const before = "Original paragraph.\n",
    after = "Revised paragraph.\n";
  const result = paragraphDifference(before, after, {
    now: () => (calls++ ? 61 : 0),
    milliseconds: 60,
    blockMilliseconds: 40,
    maxEdits: 2048,
  });
  expect(result.coarse).toBe(true);
  const document = parseDOM(sourceDiffView({ patch: "", paragraphs: result })).window.document;
  expect(projection(document.querySelector(".diff-content"), "before")).toBe(before.trim());
  expect(projection(document.querySelector(".diff-content"), "after")).toBe(after.trim());
});
test("excessive changes retain whole paragraphs when fine matching is bounded", () => {
  const before = Array.from({ length: 2200 }, (_, index) => `old${String(index)}.`).join("\n\n");
  const after = Array.from({ length: 2200 }, (_, index) => `new${String(index)}.`).join("\n\n");
  const result = paragraphDifference(before, after);
  expect(result.coarse).toBe(true);
  expect(result.changes.filter((entry) => entry.before !== null)).toHaveLength(2200);
  expect(result.changes.filter((entry) => entry.after !== null)).toHaveLength(2200);
  expect(sourceDiffView({ patch: "", paragraphs: result })).toContain("complete paragraph additions and removals");
});
