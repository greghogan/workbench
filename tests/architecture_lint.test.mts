import { ESLint, Linter, type Linter as LintTypes } from "eslint";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("shared services cannot import CLI presentation while startup can compose interfaces", async () => {
  const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "..") });
  const lint = new Linter();
  for (const [file, module, forbidden] of [
    ["src/collection-service.ts", "./cli/collections.js", true],
    ["src/container-startup.ts", "./cli/development.js", true],
    ["src/record-creation.ts", "./cli/records.js", true],
    ["src/web/collection-service.ts", "../cli/collections.js", true],
    ["src/web/record-pages.tsx", "../cli/records.js", true],
    ["src/web/page-document.tsx", "./asset-response.js", true],
    ["src/web/page-document.tsx", "./asset-manifest.js", false],
    ["src/web/citation-documents.ts", "./content-negotiation.js", false],
    ["src/build-cache.ts", "./cli/cache.js", true],
    ["src/record-identity.ts", "./cli/records.js", true],
    ["src/main.ts", "./cli/commands.js", false],
    ["src/launcher.ts", "./cli/commands.js", false],
    ["src/cli/collections.ts", "../collection-service.js", false],
  ] as const) {
    const configuration = (await eslint.calculateConfigForFile(file)) as LintTypes.Config;
    const rule = configuration.rules?.["no-restricted-imports"];
    const issues = lint.verify(`import { capability } from ${JSON.stringify(module)};`, {
      rules: rule ? { "no-restricted-imports": rule } : {},
    });
    expect(
      issues.some((issue) => issue.ruleId === "no-restricted-imports"),
      file,
    ).toBe(forbidden);
  }
});

test("static DOM tests require owned windows while controller sessions retain their lifecycle", async () => {
  const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "..") });
  const lint = new Linter();
  for (const [file, module, symbol, forbidden] of [
    ["tests/web_source_navigation.test.mts", "jsdom", "JSDOM", true],
    ["tests/web_source_navigation.test.mts", "./fixtures/dom.mjs", "parseDOM", false],
    ["tests/web_client.test.mts", "jsdom", "JSDOM", false],
  ] as const) {
    const configuration = (await eslint.calculateConfigForFile(file)) as LintTypes.Config;
    const rule = configuration.rules?.["no-restricted-imports"];
    const issues = lint.verify(`import { ${symbol} } from ${JSON.stringify(module)};`, {
      rules: rule ? { "no-restricted-imports": rule } : {},
    });
    expect(
      issues.some((issue) => issue.ruleId === "no-restricted-imports"),
      file,
    ).toBe(forbidden);
  }
});
