import { expect, test } from "vitest";
import { renderToString } from "preact-render-to-string";
import { codeDifference } from "../../../src/server/views/code-difference.tsx";
import { parseDOM } from "../../fixtures/dom.mjs";

test("complete rewrites preserve both literal files when detailed matching is bounded", () => {
  const before = Array.from({ length: 2100 }, (_, index) => `previous ${String(index)} <script>old()</script>\n`).join(
      "",
    ),
    after = Array.from({ length: 2100 }, (_, index) => `current ${String(index)} <script>new()</script>\n`).join(""),
    page = parseDOM(renderToString(codeDifference(before, after, false))).window.document;
  expect(page.querySelector('[aria-label="Previous file"]')?.textContent).toBe(before);
  expect(page.querySelector('[aria-label="Current file"]')?.textContent).toBe(after);
  expect(page.querySelector("script")).toBeNull();
  expect(page.querySelector(".notice")?.textContent).toContain("both complete files");
});
