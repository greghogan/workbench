import { interfaceBoundaries, centralizedProjectPaths } from "../../../../scripts/module-boundaries.mts";
import tseslint from "typescript-eslint";
import { ESLint, Linter, type Linter as LintTypes } from "eslint";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("project paths are centralized in production while independent layout fixtures remain allowed", async () => {
  const cwd = resolve(import.meta.dirname, "../../../.."),
    eslint = new ESLint({ cwd }),
    lint = new Linter({ cwd });
  for (const [file, code, forbidden] of [
    ["app/src/core/records/record-sequences.ts", 'void "workbench/state.toml";', true],
    ["app/src/core/records/record-sequences.ts", 'void "workbench/config.toml";', true],
    ["app/src/core/records/record-sequences.ts", "void projectPaths.state;", false],
    ["app/src/core/projects/project-paths.ts", 'void "workbench/state.toml";', false],
    ["app/test/core/records/record_allocation_lock.test.mts", 'void "workbench/state.toml";', false],
  ] as const) {
    const configuration = (await eslint.calculateConfigForFile(file)) as LintTypes.Config;
    const issues = lint.verify(
      code,
      {
        files: ["**/*.{ts,tsx,mts}"],
        plugins: { architecture: { rules: { "project-paths": centralizedProjectPaths } } },
        rules: { "architecture/project-paths": configuration.rules?.["architecture/project-paths"] ?? "off" },
      },
      { filename: file },
    );
    expect(
      issues.map((issue) => issue.ruleId),
      file,
    ).toEqual(forbidden ? ["architecture/project-paths"] : []);
  }
});

test("shared services cannot import CLI presentation while startup can compose interfaces", async () => {
  const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "../../../..") });
  const lint = new Linter({ cwd: resolve(import.meta.dirname, "../../../..") });
  for (const [file, module, forbidden] of [
    ["app/src/core/collections/collection-service.ts", "../../cli/collections.js", true],
    ["app/src/core/artifacts/container-startup.ts", "../../cli/development.js", true],
    ["app/src/core/records/record-creation.ts", "../../cli/records.js", true],
    ["app/src/server/projects/collection-service.ts", "../../cli/collections.js", true],
    ["app/src/server/views/record-pages.tsx", "../../cli/records.js", true],
    ["app/src/server/views/page-document.tsx", "../http/asset-response.js", true],
    ["app/src/server/views/page-document.tsx", "../browser/asset-manifest.js", false],
    ["app/src/server/documents/citation-documents.ts", "../http/content-negotiation.js", false],
    ["app/src/core/storage/build-cache.ts", "../../cli/cache.js", true],
    ["app/src/core/records/record-service.ts", "../../server/http/server.js", true],
    ["app/src/core/toolchains/maven/maven-files.ts", "../../../server/http/server.js", true],
    ["app/src/core/citations/citations.ts", "../../server/documents/citation-documents.js", true],
    ["app/src/core/records/record-service.ts", "../runtime/paths.js", false],
    ["app/src/core/records/record-identity.ts", "../projects/project-configuration.js", true],
    ["app/src/core/runtime/files.ts", "../execution/checks/checks.js", true],
    ["app/src/core/storage/build-cache.ts", "../diagnostics/terminal-table.js", true],
    ["app/src/core/storage/build-cache.ts", "../runtime/paths.js", false],
    ["app/src/server/http/server.ts", "../../core/records/record-service.js", false],
    ["app/src/cli/server.ts", "../server/projects/project-hub.js", false],
    ["app/src/core/records/record-identity.ts", "../../cli/records.js", true],
    ["app/src/cli/main.ts", "./commands.js", false],
    ["app/src/cli/launcher.ts", "./commands.js", false],
    ["app/src/cli/launcher.ts", "../../../scripts/node-runtimes.mjs", true],
    ["app/src/server/workspace/worker-generation.ts", "../../../../scripts/bundle-artifacts.mjs", true],
    ["app/src/core/distribution/bootstrap.ts", "../../../../scripts/node-runtimes.mjs", true],
    ["app/src/cli/launcher.ts", "../core/distribution/node-runtimes.mjs", false],
    ["app/src/cli/collections.ts", "../core/collections/collection-service.js", false],
  ] as const) {
    const configuration = (await eslint.calculateConfigForFile(file)) as LintTypes.Config;
    const rule = configuration.rules?.["no-restricted-imports"];
    const issues = lint.verify(
      `import { capability } from ${JSON.stringify(module)};`,
      {
        files: ["**/*.{ts,tsx}"],
        plugins: { architecture: { rules: { "interface-boundaries": interfaceBoundaries } } },
        rules: {
          ...(rule ? { "no-restricted-imports": rule } : {}),
          "architecture/interface-boundaries": configuration.rules?.["architecture/interface-boundaries"] ?? "off",
        },
      },
      { filename: file },
    );
    expect(
      issues.some((issue) =>
        ["no-restricted-imports", "architecture/interface-boundaries"].includes(issue.ruleId ?? ""),
      ),
      file,
    ).toBe(forbidden);
  }
});

test("static DOM tests require owned windows while controller sessions retain their lifecycle", async () => {
  const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "../../../..") });
  const lint = new Linter();
  for (const [file, module, symbol, forbidden] of [
    ["app/test/server/views/web_source_navigation.test.mts", "jsdom", "JSDOM", true],
    ["app/test/server/views/web_source_navigation.test.mts", "./fixtures/dom.mjs", "parseDOM", false],
    ["app/test/server/browser/web_client.test.mts", "jsdom", "JSDOM", false],
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

test("deferred and type-only imports preserve the core and server boundaries", () => {
  const cwd = resolve(import.meta.dirname, "../../../..");
  const lint = new Linter({ cwd: resolve(cwd, "app") });
  for (const [file, code, forbidden] of [
    ["core/records/records.ts", 'void import("../../server/http/server.js");', true],
    ["core/records/records.ts", 'type Interface = import("../../cli/records.js").Interface;', true],
    ["server/http/server.ts", 'const interfaceCode = require("../../cli/records.js");', true],
    ["core/records/records.ts", 'export * from "../../server/http/server.js";', true],
    ["core/records/records.ts", 'void import("../runtime/paths.js");', false],
    ["server/http/server.ts", 'type Record = import("../../core/records/records.js").Record;', false],
    ["core/records/records.ts", 'import process from "node:process";', false],
  ] as const) {
    const issues = lint.verify(
      code,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { architecture: { rules: { "interface-boundaries": interfaceBoundaries } } },
          rules: { "architecture/interface-boundaries": "error" },
        },
      ],
      { filename: resolve(cwd, "app/src", file) },
    );
    expect(
      issues.some((issue) => issue.fatal),
      code,
    ).toBe(false);
    expect(
      issues.some((issue) => issue.ruleId === "architecture/interface-boundaries"),
      code,
    ).toBe(forbidden);
  }
});

test("Node services reject browser globals while explicit DOM inputs and browser controllers remain valid", async () => {
  const cwd = resolve(import.meta.dirname, "../../../..");
  const eslint = new ESLint({ cwd });
  const lint = new Linter({ cwd });
  for (const [file, code, forbidden] of [
    ["app/src/core/records/records.ts", "window.location.reload();", true],
    ["app/src/server/http/server.ts", "document.querySelector('main');", true],
    ["app/src/core/citations/citation-html.ts", "globalThis.document.title;", true],
    ["app/src/core/records/records.ts", "localStorage.clear();", true],
    ["app/src/server/http/server.ts", "function title(document) { return document.title; }", false],
    ["app/src/core/citations/citation-html.ts", "function parse(window) { return window.document; }", false],
    ["app/src/server/browser/client.ts", "document.querySelector('main');", false],
  ] as const) {
    const configuration = (await eslint.calculateConfigForFile(file)) as LintTypes.Config;
    const issues = lint.verify(code, {
      languageOptions: { globals: configuration.languageOptions?.globals ?? {} },
      rules: Object.fromEntries(
        ["no-restricted-globals", "no-restricted-syntax"].flatMap((name) =>
          configuration.rules?.[name] ? [[name, configuration.rules[name]]] : [],
        ),
      ),
    });
    expect(
      issues.some((issue) => issue.fatal),
      code,
    ).toBe(false);
    expect(issues.length > 0, `${file}: ${code}`).toBe(forbidden);
  }
});
