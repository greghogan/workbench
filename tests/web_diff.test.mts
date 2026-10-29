import { renderToString } from "preact-render-to-string";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseDOM } from "./fixtures/dom.mjs";
import { compareDocuments, textChanges } from "../src/web/document-comparison.ts";
import { sourceDiffView } from "../src/web/diff-view.js";
import { markdown } from "../src/web/markdown-view.js";
import { RecordLookup } from "../src/record-lookup.ts";
import { readFileSync } from "node:fs";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const records = new RecordLookup([]);

test.each([false, true])(
  "bare references retain links and preview metadata throughout review differences (%s)",
  (split) => {
    const record = (number: string) => ({
      id: `demo:ADR-${number}`,
      type: "ADR" as const,
      scope: "demo",
      title: `Decision ${number}`,
      summary: "The review contract.",
      status: "",
      path: `workbench/decisions/ADR-0${number}.md`,
      directory: "/fixture",
      local: false,
      collection: false,
      editable: true,
    });
    const owner = record("8"),
      lookup = new RecordLookup([owner, record("0"), record("1")]);
    const before = "Follow ADR-0. Keep `ADR-1` literal and [the review contract](ADR-01.md).\n",
      after =
        "Follow ADR-1. Keep `ADR-1` literal and [the review contract](ADR-01.md).\n\nADR-1 defines shared review.\n";
    const document = parseDOM(
      renderToString(sourceDiffView({ before, after, patch: "" }, { record: owner, records: lookup }, split)),
    ).window.document;
    for (const number of ["0", "1"]) {
      const links = [...document.querySelectorAll(`a[data-record-reference="demo:ADR-${number}"]`)];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.getAttribute("href")).toBe(`/records/demo:ADR-${number}`);
        expect(link.getAttribute("data-record-title")).toBe(`Decision ${number}`);
        expect(link.getAttribute("data-record-summary")).toBe("The review contract.");
      }
    }
    expect(document.querySelector('ins a[data-record-reference="demo:ADR-1"]')).not.toBeNull();
    expect(document.querySelectorAll("code a,a a")).toHaveLength(0);
    for (const [side, contents] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const expected = parseDOM(renderToString(markdown(contents, owner, lookup))).window.document.body;
      expect(projection(document, side, split)).toBe(normalize(readable(expected)));
    }
  },
);
// Matching semantics must not depend on host load. Budget exhaustion has its own injected-clock regressions.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "performance"] }));
afterEach(() => vi.useRealTimers());
const render = (before: string, after: string, split = false, pageTitle?: string) =>
  renderToString(sourceDiffView({ before, after, patch: "" }, { records, ...(pageTitle ? { pageTitle } : {}) }, split));
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
function readable(node: Node): string {
  const content = [...node.childNodes]
    .map((child) => (child.nodeType === 3 ? (child.textContent ?? "") : readable(child)))
    .join("");
  return (
    content +
    (node.nodeType === 1 &&
    /^(H[1-6]|P|SECTION|ARTICLE|LI|PRE|BLOCKQUOTE|TR|TD|TH|DIV)$/.test((node as Element).tagName)
      ? " "
      : "")
  );
}
function projection(document: Document, side: "before" | "after", split = false): string {
  const root = document.querySelector(".document-diff")?.cloneNode(true) as Element | undefined;
  if (!root) throw new Error("Missing formatted comparison");
  for (const node of root.querySelectorAll(`${side === "before" ? "ins" : "del"},.diff-separator,.column-labels`))
    node.remove();
  if (split)
    return normalize([...root.querySelectorAll(`[data-diff-side="${side}"]`)].map((node) => readable(node)).join(" "));
  return normalize(readable(root));
}
function expected(contents: string): string {
  return normalize(readable(parseDOM(renderToString(markdown(contents, undefined, records))).window.document.body));
}
const rewrite = JSON.parse(readFileSync(new URL("./fixtures/paragraph-diff.json", import.meta.url), "utf8")) as {
  before: string;
  after: string;
};

test.each([false, true])("every unchanged paragraph remains visible before and after a distant edit (%s)", (split) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Context paragraph ${String(index)} stays readable.`);
  const before = "# Decision\n\n" + paragraphs.join("\n\n") + "\n";
  const after = before.replace("paragraph 20 stays", "paragraph 20 remains");
  const document = parseDOM(render(before, after, split)).window.document;
  expect(projection(document, "before", split)).toBe(expected(before));
  expect(projection(document, "after", split)).toBe(expected(after));
  expect(document.querySelector(".document-diff del")?.textContent).toBe("stays");
  expect(document.querySelector(".document-diff ins")?.textContent).toBe("remains");
  for (const text of [paragraphs[0], paragraphs[39]])
    expect(document.querySelector(".document-diff")?.textContent).toContain(text);
});

test.each([
  ["A paragraph with several words.\n", "A paragraph with\nseveral words.\n"],
  ["- Keep the selected tool and its version.\n", "- Keep the selected tool\n  and its version.\n"],
  ["> Keep the selected tool and its version.\n", "> Keep the selected tool\n> and its version.\n"],
  ["A naïve sentence with 日本語 and café.\n", "A naïve sentence with\n日本語 and café.\n"],
])("soft wrapping keeps the complete formatted text without highlighting words", (before, after) => {
  for (const split of [false, true]) {
    const document = parseDOM(render(before, after, split)).window.document;
    expect(document.querySelectorAll(".document-diff ins,.document-diff del")).toHaveLength(0);
    expect(projection(document, "after", split)).toBe(expected(after));
  }
});

test("a rewritten paragraph groups the removed passage before the added passage", () => {
  const document = parseDOM(render(rewrite.before, rewrite.after)).window.document;
  expect(projection(document, "before")).toBe(expected(rewrite.before));
  expect(projection(document, "after")).toBe(expected(rewrite.after));
  expect([...document.querySelectorAll(".document-diff del,.document-diff ins")].map((node) => node.tagName)).toEqual([
    "DEL",
    "INS",
  ]);
  expect(
    document.querySelectorAll(".document-diff .diff-legend,.document-diff .diff-change-label,.document-diff .sr-only"),
  ).toHaveLength(0);
});

test.each([
  [
    "## Heading\n\nKeep **old** words and [a link](https://example.invalid).\n",
    "## Heading\n\nKeep **new** words and [a link](https://example.invalid).\n",
  ],
  ["- First item.\n- Second old item.\n", "- First item.\n- Second new item.\n"],
  ["> Keep a **quoted** paragraph.\n", "> Keep a **quoted** paragraph.\n\nAdd another paragraph.\n"],
  ["| Column | Value |\n| --- | --- |\n| A | old |\n", "| Column | Value |\n| --- | --- |\n| A | new |\n"],
  ["One old paragraph.\n\nA second old paragraph.\n", "One new paragraph.\n\nA second new paragraph.\n"],
  ["Keep words together.\n", "Keep words\n\ntogether.\n"],
  ["Keep words together.\n", "Keep words  \ntogether.\n"],
  ["A\n\nB\n", "B\n\nA\n"],
  ["Paragraph.\n", "- Paragraph.\n  - Nested item.\n"],
  ["", "New paragraph.\n"],
  ["Old paragraph.\n", ""],
])("both projections preserve the complete document across formatting and structural edits", (before, after) => {
  for (const split of [false, true]) {
    const document = parseDOM(render(before, after, split)).window.document;
    expect(projection(document, "before", split)).toBe(expected(before));
    expect(projection(document, "after", split)).toBe(expected(after));
  }
});

test("rendered changes retain headings, lists, code, links, and safe escaping", () => {
  const before =
    "## Context\n\nUse **old** text, `code`, and [docs](https://example.invalid).\n\n- Keep this item.\n\n```ts\nconst value = 1;\n```\n\n<script>unsafe()</script>\n";
  const after = before.replace("**old**", "**new**");
  const document = parseDOM(render(before, after)).window.document;
  expect(document.querySelector(".document-diff h2")?.textContent).toBe("Context");
  expect(document.querySelector("del strong")?.textContent).toBe("old");
  expect(document.querySelector("ins strong")?.textContent).toBe("new");
  expect(document.querySelector(".document-diff li")?.textContent).toBe("Keep this item.");
  expect(document.querySelector(".document-diff a")?.getAttribute("href")).toBe("https://example.invalid");
  expect(document.querySelector(".document-diff pre code")?.textContent).toBe("const value = 1;\n");
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector(".document-diff")?.textContent).toContain("<script>unsafe()</script>");
});

test("changed link destinations and formatting stay reviewable even when visible words are identical", () => {
  const document = parseDOM(
    render(
      "Use [docs](https://old.invalid) and plain text.\n",
      "Use [docs](https://new.invalid) and **plain** text.\n",
    ),
  ).window.document;
  expect(document.querySelector("del a")?.getAttribute("href")).toBe("https://old.invalid");
  expect(document.querySelector("ins a")?.getAttribute("href")).toBe("https://new.invalid");
  expect(document.querySelector("ins strong")?.textContent).toBe("plain");
});

test.each([false, true])(
  "Summary and Agent instructions use normal sections while comment edits remain identified (%s)",
  (split) => {
    const before =
      "---\n# Keep the old comment.\nsummary: Keep old behavior.\nagent_instruction: Preserve user work.\n---\n\n# ADR-1: Decision\n\nBody context.\n";
    const after = before.replace("old comment", "new comment").replace("old behavior", "new behavior");
    const document = parseDOM(render(before, after, split)).window.document;
    expect([...document.querySelectorAll(".document-diff h2")].map((node) => node.textContent)).toContain("Summary");
    expect([...document.querySelectorAll(".document-diff h2")].map((node) => node.textContent)).toContain(
      "Agent instructions",
    );
    expect([...document.querySelectorAll(".document-diff h2")].some((node) => node.textContent === "Metadata")).toBe(
      false,
    );
    expect(projection(document, "before", split)).toBe(expected(before));
    expect(projection(document, "after", split)).toBe(expected(after));
    expect(document.querySelector("details.source-comparison")).toBeNull();
    expect(document.querySelector(".notice")?.textContent).toBe("Frontmatter comments also changed.");
  },
);

test("comment-only and wrapping-only changes retain the entire unchanged formatted document", () => {
  const before = "---\n# Old comment\nsummary: Keep behavior.\n---\n\nA long paragraph with context.\n";
  const after = before.replace("Old comment", "New comment").replace("paragraph with", "paragraph\nwith");
  const document = parseDOM(render(before, after)).window.document;
  expect(document.querySelectorAll(".document-diff ins,.document-diff del")).toHaveLength(0);
  expect(document.querySelector(".notice")?.textContent).toContain("Only source formatting or comments changed");
  expect(normalize(document.querySelector(".document-diff")?.textContent ?? "")).toContain(
    "A long paragraph with context.",
  );
  expect(document.querySelector(".source-comparison")).toBeNull();
});

test("literal code whitespace remains visible and malformed YAML is diagnosed without a raw diff", () => {
  const before = "---\nsummary: [broken\n---\n\n```text\n\tone two\n```\n";
  const after = before.replace("one two", "one\ttwo");
  const document = parseDOM(render(before, after)).window.document;
  expect(document.querySelector("details.source-comparison")).toBeNull();
  expect(document.querySelector(".notice")?.textContent).toContain("could not be parsed");
  expect(document.querySelector(".document-diff del")?.textContent).toBe("\tone two\n");
  expect(document.querySelector(".document-diff ins")?.textContent).toBe("\tone\ttwo\n");
  expect(document.querySelectorAll(".source-comparison pre")).toHaveLength(0);
});

test("mixed edits retain nested YAML comments without treating quoted or block scalar content as comments", () => {
  const before =
    "---\nsummary: 'Keep # words.'\nextensions:\n  items:\n    - item # original comment\n  text: |\n    # literal text\n---\n\nOld body.\n";
  const mixed = parseDOM(
    render(before, before.replace("original comment", "changed comment").replace("Old body", "New body")),
  ).window.document;
  expect(mixed.querySelector(".notice")?.textContent).toBe("Frontmatter comments also changed.");
  for (const after of [
    before.replace("# words", "# changed words"),
    before.replace("# literal text", "# changed literal text"),
  ]) {
    const document = parseDOM(render(before, after)).window.document;
    expect(document.querySelector(".notice")).toBeNull();
    expect(document.querySelector(".document-diff ins")).not.toBeNull();
  }
});

test.each([false, true])(
  "unused Markdown reference definitions remain discoverable with or without a paragraph edit (%s)",
  (editBody) => {
    const before = "Old body.\n\n[future]: https://old.invalid\n";
    const after = before
      .replace("https://old.invalid", "https://new.invalid")
      .replace("Old body", editBody ? "New body" : "Old body");
    const document = parseDOM(render(before, after)).window.document;
    expect([...document.querySelectorAll(".notice")].map((node) => node.textContent)).toEqual([
      "Reference definitions changed.",
    ]);
    expect(document.querySelector(".document-diff del")?.textContent ?? "").toBe(editBody ? "Old" : "");
    expect(document.querySelector(".source-comparison")).toBeNull();
  },
);

test("side-by-side column names remain available to assistive technology without visible heading text", () => {
  const document = parseDOM(render("Old.\n", "New.\n", true)).window.document;
  const headers = [...document.querySelectorAll(".document-diff-table > thead th[scope=col]")];
  expect(headers.map((node) => node.getAttribute("aria-label"))).toEqual(["Previous", "Current"]);
  expect(headers.map((node) => node.querySelector(".sr-only")?.textContent)).toEqual(["Previous", "Current"]);
});

test("headings in the two columns have distinct anchors and local fragment links stay in their column", () => {
  const contents = "## Context\n\nRead [context](#context).\n";
  const document = parseDOM(render(contents, contents, true)).window.document;
  expect(document.querySelector('[data-diff-side="before"] h2')?.id).toBe("previous-context");
  expect(document.querySelector('[data-diff-side="after"] h2')?.id).toBe("current-context");
  expect(document.querySelector('[data-diff-side="before"] a')?.getAttribute("href")).toBe("#previous-context");
  expect(document.querySelector('[data-diff-side="after"] a')?.getAttribute("href")).toBe("#current-context");
});

test("unchanged document titles are suppressed once and changed titles remain visible", () => {
  const same = parseDOM(render("# Decision\n\nOld.\n", "# Decision\n\nNew.\n", false, "Decision")).window.document;
  expect(same.querySelector(".document-diff h2")).toBeNull();
  const changed = parseDOM(render("# Old title\n", "# New title\n", false, "New title")).window.document;
  expect(changed.querySelector("h2 del")?.textContent).toContain("Old");
  expect(changed.querySelector("h2 ins")?.textContent).toContain("New");
});

test("bounded matching retains every block when fine comparisons are exhausted", () => {
  const before = Array.from({ length: 2200 }, (_, index) => `old${String(index)}.`).join("\n\n");
  const after = Array.from({ length: 2200 }, (_, index) => `new${String(index)}.`).join("\n\n");
  const result = compareDocuments(before, after, undefined, { budget: { now: () => 1, milliseconds: 0, maxEdits: 0 } });
  expect(result.coarse).toBe(true);
  expect(result.rows).toHaveLength(2200);
  const document = parseDOM(render(before, after)).window.document;
  expect(projection(document, "before")).toBe(expected(before));
  expect(projection(document, "after")).toBe(expected(after));
});

test("text changes group one removed and added passage without losing unchanged outer context", () => {
  const parts = textChanges("Keep the old words and their behavior.", "Keep the new words and the behavior.");
  expect(parts.filter((part) => part.change === "removed")).toHaveLength(1);
  expect(parts.filter((part) => part.change === "added")).toHaveLength(1);
  for (const side of ["before", "after"] as const)
    expect(
      parts
        .filter((part) => part.change !== (side === "before" ? "added" : "removed"))
        .map((part) => part.text)
        .join(""),
    ).toBe(side === "before" ? "Keep the old words and their behavior." : "Keep the new words and the behavior.");
});

test.each([
  ["100644", "100755", "Executable permission added"],
  ["100755", "100644", "Executable permission removed"],
  ["100644", "120000", "File type: Regular file → Symbolic link"],
])("formatted comparisons explain %s to %s changes without raw Git modes", (beforeMode, afterMode, label) => {
  const mode = renderToString(
    sourceDiffView(
      {
        before: "Same text.\n",
        after: "Same text.\n",
        patch: `diff --git a/ADR.md b/ADR.md\nold mode ${beforeMode}\nnew mode ${afterMode}\n`,
      },
      { records },
    ),
  );
  expect(mode).toContain(label);
  expect(mode).not.toContain(beforeMode);
  expect(mode).not.toContain(afterMode);
  expect(mode).toContain("Same text.");
});

test("edited heading links resolve against the heading shown in each column", () => {
  const document = parseDOM(
    render("## Old heading\n\n[Jump](#old-heading).\n", "## New heading\n\n[Jump](#new-heading).\n", true),
  ).window.document;
  const before = document.querySelector('[data-diff-side="before"] h2');
  const after = document.querySelector('[data-diff-side="after"] h2');
  if (!before || !after) throw new Error("Missing compared headings");
  expect(before.id).toBe("previous-old-heading");
  expect(after.id).toBe("current-new-heading");
  expect(document.querySelector('[data-diff-side="before"] a')?.getAttribute("href")).toBe("#" + before.id);
  expect(document.querySelector('[data-diff-side="after"] a')?.getAttribute("href")).toBe("#" + after.id);
});

test("added and removed metadata, including structured values, remains visible on its own side", () => {
  const before =
    "---\nsummary: Keep context.\nagent_instruction: Old instruction.\nextensions: { owner: team, flags: [a, b] }\n---\n\nBody.\n";
  const after = "---\nsummary: Keep context.\nextensions: { owner: other, flags: [a, b, c] }\n---\n\nBody.\n";
  for (const split of [false, true]) {
    const document = parseDOM(render(before, after, split)).window.document;
    expect(projection(document, "before", split)).toBe(expected(before));
    expect(projection(document, "after", split)).toBe(expected(after));
    expect([...document.querySelectorAll(".document-diff del")].map((node) => node.textContent).join(" ")).toContain(
      "team",
    );
    expect([...document.querySelectorAll(".document-diff ins")].map((node) => node.textContent).join(" ")).toContain(
      "other",
    );
  }
});

test("table alignment and column changes keep valid complete tables in both layouts", () => {
  const before = "| A | B |\n| :--- | ---: |\n| one | two |\n";
  const after = "| A | B | C |\n| ---: | :--- | --- |\n| one | two | three |\n";
  const unified = parseDOM(render(before, after)).window.document;
  expect(unified.querySelectorAll(".document-diff .document table")).toHaveLength(2);
  const split = parseDOM(render(before, after, true)).window.document;
  const old = split.querySelector('[data-diff-side="before"] .document table');
  const current = split.querySelector('[data-diff-side="after"] .document table');
  expect(old?.querySelectorAll("thead th")).toHaveLength(2);
  expect(current?.querySelectorAll("thead th")).toHaveLength(3);
  expect(old?.querySelector("thead th")?.getAttribute("style")).toContain("left");
  expect(current?.querySelector("thead th")?.getAttribute("style")).toContain("right");
  expect(projection(unified, "before")).toBe(expected(before));
  expect(projection(unified, "after")).toBe(expected(after));
});

function semanticDocument(document: Document, side?: "before" | "after", split = false): unknown {
  const container = document.createElement("div");
  if (side) {
    const root = document.querySelector(".document-diff");
    if (!root) throw new Error("Missing comparison");
    for (const node of split ? root.querySelectorAll(`[data-diff-side="${side}"]`) : [root])
      for (const child of node.childNodes) container.append(child.cloneNode(true));
    for (const node of container.querySelectorAll(side === "before" ? "ins,.diff-separator" : "del,.diff-separator"))
      node.remove();
    for (const annotation of container.querySelectorAll("ins,del")) annotation.replaceWith(...annotation.childNodes);
  } else for (const child of document.body.childNodes) container.append(child.cloneNode(true));
  container.normalize();
  const project = (node: Node): unknown[] => {
    if (node.nodeType === 3)
      return [
        node.parentElement?.closest("pre") ? node.textContent : (node.textContent ?? "").replace(/\s+/g, " "),
      ].filter((text) => text?.trim());
    const element = document.defaultView?.Element;
    if (!element || !(node instanceof element)) return [];
    const children = [...node.childNodes].flatMap(project);
    if (["DIV", "ARTICLE"].includes(node.tagName)) return children;
    return [
      [
        node.tagName,
        Object.fromEntries(
          ["href", "start", "scope", "colspan"].flatMap((key) =>
            node.hasAttribute(key) ? [[key, node.getAttribute(key)]] : [],
          ),
        ),
        children,
      ],
    ];
  };
  return [...container.childNodes].flatMap(project);
}

test.each([false, true])("comparison preserves the ordinary document's semantic structure (%s)", (split) => {
  const before =
    "## Decision\n\n- First **old** item.\n  - Nested `code`.\n- Other item.\n\n> Quoted paragraph.\n>\n> Another paragraph.\n\n| Key | Value |\n| --- | --- |\n| A | old |\n\n```js\n  const value = 1;\n```\n";
  const after = before.replaceAll("old", "new");
  const document = parseDOM(render(before, after, split)).window.document;
  for (const [side, contents] of [
    ["before", before],
    ["after", after],
  ] as const) {
    const ordinary = parseDOM(renderToString(markdown(contents, undefined, records))).window.document;
    expect(semanticDocument(document, side, split)).toEqual(semanticDocument(ordinary));
  }
});

test("document tables retain native semantics within a named keyboard-accessible scrolling region", () => {
  const document = parseDOM(
    renderToString(
      markdown("| Field | Value |\n| --- | --- |\n| Input | <script>unsafe</script> |\n", undefined, records),
    ),
  ).window.document;
  const wrapper = document.querySelector('[role="region"][aria-label="Document table"]');
  expect(wrapper?.getAttribute("tabindex")).toBe("0");
  expect(wrapper?.querySelector("table thead th")?.textContent).toBe("Field");
  expect(wrapper?.querySelector("table tbody td")?.textContent).toBe("Input");
  expect(wrapper?.querySelector("script")).toBeNull();
  expect(wrapper?.textContent).toContain("<script>unsafe</script>");
});

test("document anchors do not collide with interface controls and record section links target the rendered document", () => {
  const other = {
    id: "demo:ADR-1",
    type: "ADR" as const,
    scope: "demo",
    title: "Other decision",
    summary: "",
    status: "",
    path: "workbench/decisions/ADR-01.md",
    directory: "/fixture",
    local: false,
    collection: false,
    editable: true,
  };
  const lookup = new RecordLookup([other]);
  const contents = "# Main\n\n[Local](#main) and [Other](ADR-01.md#main).\n\n## Global search\n";
  const html = renderToString(
    markdown(contents, { directory: "/fixture", path: "workbench/decisions/ADR-00.md" }, lookup),
  );
  const document = parseDOM('<input id="global-search"><main id="main">' + html + "</main>").window.document;
  expect([...document.querySelectorAll("[id]")].map((element) => element.id)).toEqual([
    "global-search",
    "main",
    "document-main",
    "document-global-search",
  ]);
  expect(document.querySelector("article a")?.getAttribute("href")).toBe("#document-main");
  expect(document.querySelectorAll("article a")[1]?.getAttribute("href")).toBe("/records/demo:ADR-1#document-main");
});

test("identical sources produce an empty patch without starting a Git process", async () => {
  const child = await import("node:child_process");
  const { contentsDiff } = await import("../src/web/diff.ts");
  const spawn = vi.mocked(child.spawnSync);
  spawn.mockClear();
  try {
    expect(contentsDiff("Unchanged document.\n", "Unchanged document.\n", "workbench/decisions/ADR-00.md")).toBe("");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockClear();
  }
});
