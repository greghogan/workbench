import { expect, test } from "vitest";
import { markdownExcerpt } from "../../../src/core/records/markdown-excerpt.ts";
test("excerpts retain readable prose and alt text while removing Markdown syntax", () => {
  expect(
    markdownExcerpt(
      "# Heading\n\nReview **bold** [linked work](TSK-08.md) and `code`, ![a diagram](figure.svg).\nNext line.\n\nAnother paragraph.",
    ),
  ).toBe("Review bold linked work and code, a diagram. Next line.");
  expect(markdownExcerpt("# Heading only")).toBe("");
  expect(markdownExcerpt("Text with naïve 日本語 &amp; symbols.")).toBe("Text with naïve 日本語 & symbols.");
});
test("task previews prefer the overview without mistaking fenced headings or later details for it", () => {
  const contents =
    "# Plan\n\n## Decisions\n\nChoose a platform.\n\n```markdown\n## Overview\nNot the real overview.\n```\n\n## Overview\n\nDeliver **safe** recovery.\n\n## Agent detail\n\nImplementation procedure.\n";
  expect(markdownExcerpt(contents, ["Overview", "Review summary"])).toBe("Deliver safe recovery.");
  expect(
    markdownExcerpt(contents.replace("## Overview\n\nDeliver", "## Review summary\n\nDeliver"), [
      "Overview",
      "Review summary",
    ]),
  ).toBe("Deliver safe recovery.");
  expect(markdownExcerpt(contents)).toBe("Choose a platform.");
  expect(markdownExcerpt("# Plan\n\nA short plan without sections.", ["Overview", "Review summary"])).toBe(
    "A short plan without sections.",
  );
});
