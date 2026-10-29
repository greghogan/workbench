import { untrackedToolingOutputs, bundledOutputs } from "./scripts/tooling-artifacts.mts";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import { explainedSecurityExceptions } from "./scripts/security-lint.mjs";
import { jsxRenderingRules } from "./scripts/jsx-rendering-lint.mjs";

const commandPresentationImports = {
  group: ["./cli/*", "../cli/*"],
  message: "Shared services and web presentation must not depend on CLI presentation; compose them at startup.",
};

export default defineConfig(
  // Example checks create and remove reports concurrently; these are generated data, not source scripts.
  { ignores: [...untrackedToolingOutputs, ...bundledOutputs, "examples/*/*/coverage/**"] },
  js.configs.recommended,
  {
    plugins: { security: { rules: { "explained-exceptions": explainedSecurityExceptions } } },
    rules: { "security/explained-exceptions": "error" },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" },
    // Add correctness checks beyond the recommended baseline; Prettier owns layout.
    rules: {
      eqeqeq: ["error", "always"],
      "no-constructor-return": "error",
      "no-extend-native": "error",
      "no-new-wrappers": "error",
      "no-promise-executor-return": "error",
      "no-return-assign": ["error", "always"],
      "no-self-compare": "error",
      "no-throw-literal": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-unused-expressions": "error",
      "no-useless-assignment": "error",
      "no-alert": "error",
      "no-caller": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
    },
  },
  {
    files: ["**/*.mjs", "bin/*.cjs", ".pnpmfile.cjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "src/**/*.{ts,tsx}",
      "scripts/**/*.mts",
      "tests/**/*.mts",
      "examples/**/scripts/*.mts",
      "bin/*.cts",
      "*.mts",
    ],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-enum-assignment": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  ...jsxRenderingRules,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["command", "addCommand"].map((property) => ({
          object: "program",
          property,
          message: "Register top-level commands through registerCommand so admission metadata is required.",
        })),
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/main.ts", "src/launcher.ts", "src/cli/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [commandPresentationImports] }] },
  },
  {
    files: ["src/web/*-pages.tsx", "src/web/*-page.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [commandPresentationImports],
          paths: [
            {
              name: "node:fs",
              message: "Render pages from the prepared workspace snapshot; filesystem acquisition belongs to workers.",
            },
            {
              name: "node:fs/promises",
              message: "Render pages from the prepared workspace snapshot; filesystem acquisition belongs to workers.",
            },
            {
              name: "../task-queue.js",
              importNames: ["readTaskQueue", "inspectTaskQueue"],
              message: "Use the prepared task queue from the workspace snapshot.",
            },
            {
              name: "../task-model.js",
              importNames: ["readTaskGraph"],
              message: "Use the prepared task graph from the workspace snapshot.",
            },
            {
              name: "./components.js",
              importNames: ["textField", "textArea", "selectField", "confirmation"],
              message: "Use mutationForm's action-bound controls so submitted field names are checked.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["bin/*.cts"],
    // CommonJS bootstrap sources use TypeScript's typed import assignments.
    rules: { "@typescript-eslint/no-require-imports": ["error", { allowAsImport: true }] },
  },
  {
    files: ["tests/**/*.mts"],
    rules: {
      // Focused tests can silently reduce the executed suite.
      "no-restricted-properties": [
        "error",
        ...["test", "it", "describe"].map((object) => ({
          object,
          property: "only",
          message: "Remove focused tests before committing.",
        })),
      ],
    },
  },
  {
    files: ["tests/**/*.test.mts"],
    // Controller tests own their live browser sessions; static markup uses the teardown-managed fixture.
    ignores: ["tests/web_client.test.mts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "jsdom",
              importNames: ["JSDOM"],
              message: "Use fixtures/dom.mjs so test windows close even when assertions fail.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "scripts/maintenance/contract.mts",
      "scripts/maintenance/inventory.mts",
      "scripts/maintenance/workspace.mts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./plan.mjs", "./apply.mjs", "./main.mjs"],
              message: "Maintenance inventory and contracts must remain independent of orchestration.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/maintenance/native.mts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='replaceAll'][callee.object.type='CallExpression'][callee.object.callee.object.name='JSON']",
          message: "Update typed acquisition fields; never substitute through serialized trust metadata.",
        },
      ],
    },
  },
  {
    files: ["src/project-model.ts", "src/record-identity.ts", "src/files.ts", "src/file-reads.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            commandPresentationImports,
            {
              group: ["./checks.js", "./main.js", "./web/*", "./project-configuration.js", "./record-service.js"],
              message: "Foundational values and file operations must not depend on orchestration or presentation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/build-cache.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            commandPresentationImports,
            {
              group: ["commander", "./terminal-*", "./web/*"],
              message: "Cache services must remain independent of command and web presentation.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
