import { interfaceBoundaries, centralizedProjectPaths } from "./scripts/module-boundaries.mts";
import { untrackedToolingOutputs, bundledOutputs } from "./app/src/core/distribution/tooling-artifacts.mts";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import { explainedSecurityExceptions } from "./scripts/security-lint.mjs";
import { jsxRenderingRules } from "./scripts/jsx-rendering-lint.mjs";

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
      "app/src/**/*.{ts,tsx,mts}",
      "scripts/**/*.mts",
      "app/test/**/*.{ts,mts}",
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
  {
    files: ["app/src/core/**/*.{ts,mts}", "app/src/server/**/*.{ts,tsx}"],
    ignores: ["app/src/server/browser/**"],
    languageOptions: { globals: globals.node },
    rules: {
      "no-restricted-globals": [
        "error",
        {
          globals: ["window", "document", "navigator", "localStorage", "sessionStorage"].map((name) => ({
            name,
            message: "Browser globals belong to browser controllers; Node services receive DOM objects explicitly.",
          })),
          checkGlobalObject: true,
        },
      ],
    },
  },
  ...jsxRenderingRules,
  {
    files: ["app/src/**/*.{ts,tsx}"],
    ignores: ["app/src/core/projects/project-paths.ts"],
    rules: { "architecture/project-paths": "error" },
  },
  {
    files: ["app/src/**/*.{ts,tsx,mts}"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["command", "addCommand"].map((property) => ({
          object: "program",
          property,
          message: "Register top-level commands through registerCommand so admission metadata is required.",
        })),
        ...["error", "warn"].map((property) => ({
          object: "console",
          property,
          message:
            "Use diagnostic events or writeDiagnosticText so terminal messages are sanitized and wrapped consistently.",
        })),
      ],
    },
  },
  {
    files: ["app/src/**/*.{ts,tsx,mts}"],
    plugins: {
      architecture: {
        rules: { "interface-boundaries": interfaceBoundaries, "project-paths": centralizedProjectPaths },
      },
    },
    rules: { "architecture/interface-boundaries": "error" },
  },
  {
    files: ["app/src/server/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../http/asset-response.js",
              message: "Templates use the generated asset manifest; HTTP transport belongs to the listener.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/server/http/server.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../core/review/review-formatting.js",
              importNames: ["proposeReviewFormatting"],
              message:
                "Render formatting from the worker's captured review bytes instead of reacquiring the project on the listener.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "app/src/core/citations/citation-*.ts",
      "app/src/core/citations/citations.ts",
      "app/src/server/documents/citation-documents.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:fs",
              importNames: ["readFile", "readFileSync"],
              message: "Use bounded citation metadata reads or streaming document verification.",
            },
            {
              name: "node:fs/promises",
              importNames: ["readFile"],
              message: "Use verified descriptors with explicit citation limits.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/server/documents/citation-documents.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:fs",
              importNames: ["readFile", "readFileSync"],
              message: "Use bounded citation metadata reads or streaming document verification.",
            },
            {
              name: "node:fs/promises",
              importNames: ["readFile"],
              message: "Use verified descriptors with explicit citation limits.",
            },
            {
              name: "node:zlib",
              importNames: ["brotliDecompressSync", "brotliCompressSync"],
              message: "Use asynchronous or streaming codecs in HTTP handlers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/core/toolchains/maven/maven-*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:fs",
              importNames: ["readFile", "readFileSync"],
              message: "Use bounded Maven metadata reads or streaming artifact verification.",
            },
            {
              name: "node:fs/promises",
              importNames: ["readFile"],
              message: "Use bounded Maven metadata reads or streaming artifact verification.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/server/views/*-pages.tsx", "app/src/server/views/*-page.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
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
              name: "../../core/tasks/task-queue.js",
              importNames: ["readTaskQueue", "inspectTaskQueue"],
              message: "Use the prepared task queue from the workspace snapshot.",
            },
            {
              name: "../../core/tasks/task-model.js",
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
    files: ["app/test/**/*.{ts,mts}"],
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
    files: ["app/test/**/*.test.mts"],
    // Controller tests own their live browser sessions; static markup uses the teardown-managed fixture.
    ignores: ["app/test/server/browser/web_client.test.mts"],
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
    files: [
      "app/src/core/projects/project-model.ts",
      "app/src/core/records/record-identity.ts",
      "app/src/core/runtime/files.ts",
      "app/src/core/runtime/file-reads.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(?:^|/)(?:checks|main|program|project-configuration|record-service)\\.js$",
              message: "Foundational values and file operations must not depend on orchestration or presentation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/core/storage/build-cache.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["commander"],
              message: "Cache services must remain independent of command and web presentation.",
            },
            {
              regex: "(?:^|/)terminal-[^/]*\\.js$",
              message: "Keep terminal presentation outside the cache service.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
