import { ESLint, Linter } from "eslint";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { jsxRenderingRules } from "../scripts/jsx-rendering-lint.mjs";

test("the configured JSX rules enforce raw HTML ownership and useful accessibility checks", async () => {
  const configured: unknown = await new ESLint({ cwd: resolve(import.meta.dirname, "..") }).calculateConfigForFile(
    "src/web/record-content.tsx",
  );
  expect(configured).toHaveProperty(["rules", "jsx-a11y-x/alt-text", 0], 2);
  expect(configured).toHaveProperty(["rules", "no-restricted-syntax", 0], 2);
  const lint = new Linter();
  const issues = (code: string, path = "src/web/record-content.tsx") =>
    lint
      .verify(
        code,
        [
          { files: ["**/*.tsx"], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
          ...jsxRenderingRules,
        ],
        { filename: path },
      )
      .map((message) => message.ruleId);
  expect(issues('export const view = <article dangerouslySetInnerHTML={{__html: "raw"}} />;')).toContain(
    "no-restricted-syntax",
  );
  expect(
    issues('export const view = <article dangerouslySetInnerHTML={{__html: "raw"}} />;', "src/web/markdown-view.tsx"),
  ).not.toContain("no-restricted-syntax");
  for (const [code, rule] of [
    ['<img src="x" />', "alt-text"],
    ["<button />", "control-has-associated-label"],
    ['<a href="/records">click here</a>', "anchor-ambiguous-text"],
    ['<button aria-hidden="true">Hide</button>', "no-aria-hidden-on-focusable"],
    ['<span role="button">Act</span>', "prefer-tag-over-role"],
    ["<label>Unassociated</label>", "label-has-associated-control"],
  ] as const)
    expect(issues("export const view = " + code + ";")).toContain("jsx-a11y-x/" + rule);
  const valid = issues(
    'export const view = <><label for="fixture">Name</label><input id="fixture" /><button>Save</button></>;',
  );
  expect(valid.filter((rule) => rule?.startsWith("jsx-a11y-x/"))).toEqual([]);
});
