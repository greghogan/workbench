import fc from "fast-check";
import { codeTokens, codeHighlightLimit } from "../../../src/server/views/code-highlighting.tsx";
import { expect, test } from "vitest";
import { renderToString } from "preact-render-to-string";
import { compareFileLines, fileContext } from "../../../src/server/review/file-comparison.ts";
import { codeDifference } from "../../../src/server/views/code-difference.tsx";
import { parseDOM } from "../../fixtures/dom.mjs";

function sourceText(document: Document, side: "before" | "after") {
  return [
    ...document.querySelectorAll(
      `[data-side="${side}"] code[data-source-line], [data-side="both"] code[data-source-line]`,
    ),
  ]
    .map((line) => line.textContent + (line.getAttribute("data-newline") === "1" ? "\n" : ""))
    .join("");
}

test("complete rewrites preserve both literal files when detailed matching is bounded", () => {
  const before = Array.from({ length: 2100 }, (_, i) => `previous ${String(i)} <script>old()</script>\n`).join(""),
    after = Array.from({ length: 2100 }, (_, i) => `current ${String(i)} <script>new()</script>\n`).join(""),
    page = parseDOM(renderToString(codeDifference(before, after, false))).window.document;
  expect(sourceText(page, "before")).toBe(before);
  expect(sourceText(page, "after")).toBe(after);
  expect(page.querySelector("script")).toBeNull();
  expect(page.querySelector(".notice")?.textContent).toContain("Detailed matching is unavailable");
});

const programs = [
  ["main.c", "int main(void) { return 0; }\n"],
  ["main.cpp", "#include <vector>\nint main() { std::vector<int> values; return 0; }\n"],
  ["main.ts", 'const answer: string = "value";\n'],
  ["main.js", 'const answer = "value";\n'],
  ["main.rs", 'fn main() { let answer = "value"; }\n'],
  ["main.go", 'package main\nfunc main() { println("value") }\n'],
  ["Count.java", "public class Count { public static void main(String[] args) {} }\n"],
  ["main.py", 'def main():\n    return "value"\n'],
  ["main.rb", 'def main\n  "value"\nend\n'],
  ["main.php", '<?php function main() { return "value"; }\n'],
] as const;

test.each(programs)("syntax presentation preserves the literal %s source", (path, source) => {
  const page = parseDOM(renderToString(codeDifference(undefined, source, false, path))).window.document;
  expect(sourceText(page, "after")).toBe(source);
  expect(page.querySelector('span[class*="hljs-"]')).not.toBeNull();
});

test("multiline highlighting and unequal edit lengths preserve both versions and escape source markup", () => {
  const before = '\n/* comment\nkept */\nconst answer = "</span><script>old()</script>";\n',
    after = '\nlet prefix = 0;\n/* comment\nkept */\nconst answer = "<img src=x onerror=bad()>";\n';
  const split = parseDOM(renderToString(codeDifference(before, after, true, "main.ts"))).window.document;
  expect(sourceText(split, "before")).toBe(before);
  expect(sourceText(split, "after")).toBe(after);
  expect([...split.querySelectorAll(".hljs-comment")].map((node) => node.textContent).join("\n")).toContain(
    "comment\nkept",
  );
  expect(split.querySelector("script,img")).toBeNull();
  const unified = parseDOM(renderToString(codeDifference(before, after, false, "main.ts"))).window.document;
  expect(unified.querySelector(".diff-removed")?.textContent).toContain("old()");
  expect(unified.querySelector(".diff-added")?.textContent).toContain("prefix");
  expect(unified.querySelector("script,img")).toBeNull();
});

test("highlighted token ranges preserve whitespace and arbitrary source text without requiring a supported grammar", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("α", "💡", "\r\n", "\n", "\t", "<", ">", "&", "'", "/*", "*/", "x"), { maxLength: 100 }),
      (parts) => {
        const source = parts.join("");
        expect(
          codeTokens(source, "main.ts")
            .map((token) => token.value)
            .join(""),
        ).toBe(source);
        const unknown = parseDOM(renderToString(codeDifference(undefined, source, false, "unknown.xyz"))).window
          .document;
        expect(sourceText(unknown, "after")).toBe(source.replace(/\r\n?/g, "\n"));
        expect(unknown.querySelector("script,img")).toBeNull();
      },
    ),
    { numRuns: 50 },
  );
  const large = "const value = 1;\n".repeat(Math.ceil(codeHighlightLimit / 10));
  const page = parseDOM(renderToString(codeDifference(undefined, large, false, "main.ts"))).window.document;
  expect(sourceText(page, "after")).toBe(large);
  expect(page.querySelector('span[class*="hljs-"]')).toBeNull();
});

test.each(["source.constructor", "source.__proto__"])("unrecognized %s suffix remains literal text", (path) => {
  const source = "const value = 1;\n";
  const page = parseDOM(renderToString(codeDifference(undefined, source, false, path))).window.document;
  expect(sourceText(page, "after")).toBe(source);
  expect(page.querySelector('span[class*="hljs-"]')).toBeNull();
});

test("context controls reveal either edge without hiding changes and retain complete literal versions", () => {
  const before = Array.from({ length: 100 }, (_, i) => `Line ${String(i + 1)}\n`).join(""),
    after = before.replace("Line 30\n", "Changed 30\n").replace("Line 70\n", "Changed 70\n"),
    location = (context: string) => "/file?context=" + encodeURIComponent(context),
    render = (context?: string) =>
      parseDOM(
        renderToString(codeDifference(before, after, false, "a.md", { location, ...(context ? { context } : {}) })),
      ).window.document,
    page = render();
  expect(page.querySelectorAll(".diff-gap")).toHaveLength(3);
  expect(page.querySelectorAll(".diff-removed")).toHaveLength(2);
  expect(page.querySelectorAll(".diff-added")).toHaveLength(2);
  expect(sourceText(page, "before")).not.toContain("Line 1\n");
  const above = page.querySelector<HTMLAnchorElement>('[aria-label="Show more lines above"]');
  if (!above) throw new Error("Missing context control");
  const expanded = render(new URL(above.href, "http://localhost").searchParams.get("context") ?? "");
  expect(sourceText(expanded, "before")).toContain("Line 10\n");
  expect(sourceText(expanded, "before")).not.toContain("Line 1\n");
  const full = render("all");
  expect(sourceText(full, "before")).toBe(before);
  expect(sourceText(full, "after")).toBe(after);
  expect(full.querySelector(".diff-gap")).toBeNull();
  expect(() => fileContext("0:1:2,0:2:3")).toThrow("Repeated");
  expect(() => fileContext("../bad")).toThrow("Invalid");
});

test("line matching reconstructs both versions and assigns offsets independently of source syntax", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ maxLength: 12 }), { maxLength: 20 }),
      fc.array(fc.string({ maxLength: 12 }), { maxLength: 20 }),
      (a, b) => {
        const before = a.join("\n"),
          after = b.join("\n"),
          comparison = compareFileLines(before, after);
        for (const side of ["before", "after"] as const) {
          const lines = comparison.sections.flatMap((section) => section[side]);
          expect(lines.map((line) => line.text).join("")).toBe(side === "before" ? before : after);
          lines.forEach((line, i) => {
            expect(line.number).toBe(i + 1);
          });
          lines.forEach((line) => {
            expect((side === "before" ? before : after).slice(line.start, line.start + line.text.length)).toBe(
              line.text,
            );
          });
        }
      },
    ),
    { numRuns: 100 },
  );
});
