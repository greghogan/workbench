import { expect, test } from "vitest";
import { markdownExcerpt } from "../src/markdown-excerpt.ts";
test("excerpts retain readable prose and alt text while removing Markdown syntax", () => {
  expect(
    markdownExcerpt(
      "# Heading\n\nReview **bold** [linked work](TSK-08.md) and `code`, ![a diagram](figure.svg).\nNext line.\n\nAnother paragraph.",
    ),
  ).toBe("Review bold linked work and code, a diagram. Next line.");
  expect(markdownExcerpt("# Heading only")).toBe("");
  expect(markdownExcerpt("Text with naïve 日本語 &amp; symbols.")).toBe("Text with naïve 日本語 & symbols.");
});
