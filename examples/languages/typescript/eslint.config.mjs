import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
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
    },
  },
  { files: [".pnpmfile.cjs"], languageOptions: { globals: { process: "readonly", __dirname: "readonly" } } },
  { files: ["scripts/**/*.mjs", "*.config.mjs"], languageOptions: { globals: { process: "readonly" } } },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}"],
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
  eslintConfigPrettier,
);
