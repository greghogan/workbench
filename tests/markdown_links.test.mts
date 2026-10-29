import { expect, test } from "vitest";
import { join } from "node:path";
import { relocateMarkdownLinks } from "../src/markdown-links.ts";

test("embedded charter links preserve their targets, comments, titles and code examples", () => {
  const root = join(process.cwd(), "fixture");
  const input =
    '# Charter\n\n[Guide](../AGENTS.legacy.md "Existing") and [document](<notes/a file.md#topic>).\n\n[ref]: ../README.md\n\n<!-- retained -->\n\n`[example](../unchanged.md)`\n\n```md\n[example](../unchanged.md)\n```\n';
  const result = relocateMarkdownLinks(input, join(root, "workbench/CHARTER.md"), join(root, "AGENTS.md"));
  expect(result).toContain('[Guide](AGENTS.legacy.md "Existing")');
  expect(result).toContain("[document](<workbench/notes/a%20file.md#topic>)");
  expect(result).toContain("[ref]: README.md");
  expect(result).toContain("<!-- retained -->");
  expect(result).toContain("`[example](../unchanged.md)`");
  expect(result).toContain("```md\n[example](../unchanged.md)\n```");
});
test("subproject links, fragments, balanced paths and local absolute context are relocated", () => {
  const root = join(process.cwd(), "fixture");
  const source = join(root, "packages/api/workbench/CHARTER.md");
  const result = relocateMarkdownLinks(
    "[read](../README.md) [self](#purpose) [nested](notes/a(b).md) [remote](https://example.org/x)",
    source,
    join(root, "AGENTS.md"),
  );
  expect(result).toContain("(packages/api/README.md)");
  expect(result).toContain("(packages/api/workbench/CHARTER.md#purpose)");
  expect(result).toContain("(packages/api/workbench/notes/a%28b%29.md)");
  expect(result).toContain("(https://example.org/x)");
  expect(relocateMarkdownLinks("[read](../README.md)", source, join(root, "AGENTS.md"), true)).toContain(
    root.replaceAll("\\", "/"),
  );
});
