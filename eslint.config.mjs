// Generated from eslint.config.mts; edit the TypeScript source.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
var eslint_config_default = defineConfig(
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
      "no-useless-assignment": "error"
    }
  },
  {
    files: ["**/*.mjs", "bin/*.cjs", ".pnpmfile.cjs"],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.mts", "tests/**/*.mts", "examples/**/scripts/*.mts", "bin/*.cts", "*.mts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-enum-assignment": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error"
    }
  },
  {
    files: ["bin/*.cts"],
    // CommonJS bootstrap sources use TypeScript's typed import assignments.
    rules: { "@typescript-eslint/no-require-imports": ["error", { allowAsImport: true }] }
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
          message: "Remove focused tests before committing."
        }))
      ]
    }
  },
  eslintConfigPrettier
);
export {
  eslint_config_default as default
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImVzbGludC5jb25maWcubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBqcyBmcm9tIFwiQGVzbGludC9qc1wiO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcImVzbGludC9jb25maWdcIjtcbmltcG9ydCBlc2xpbnRDb25maWdQcmV0dGllciBmcm9tIFwiZXNsaW50LWNvbmZpZy1wcmV0dGllclwiO1xuaW1wb3J0IGdsb2JhbHMgZnJvbSBcImdsb2JhbHNcIjtcbmltcG9ydCB0c2VzbGludCBmcm9tIFwidHlwZXNjcmlwdC1lc2xpbnRcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKFxuICBqcy5jb25maWdzLnJlY29tbWVuZGVkLFxuICB7XG4gICAgbGludGVyT3B0aW9uczogeyByZXBvcnRVbnVzZWREaXNhYmxlRGlyZWN0aXZlczogXCJlcnJvclwiLCByZXBvcnRVbnVzZWRJbmxpbmVDb25maWdzOiBcImVycm9yXCIgfSxcbiAgICAvLyBBZGQgY29ycmVjdG5lc3MgY2hlY2tzIGJleW9uZCB0aGUgcmVjb21tZW5kZWQgYmFzZWxpbmU7IFByZXR0aWVyIG93bnMgbGF5b3V0LlxuICAgIHJ1bGVzOiB7XG4gICAgICBlcWVxZXE6IFtcImVycm9yXCIsIFwiYWx3YXlzXCJdLFxuICAgICAgXCJuby1jb25zdHJ1Y3Rvci1yZXR1cm5cIjogXCJlcnJvclwiLFxuICAgICAgXCJuby1leHRlbmQtbmF0aXZlXCI6IFwiZXJyb3JcIixcbiAgICAgIFwibm8tbmV3LXdyYXBwZXJzXCI6IFwiZXJyb3JcIixcbiAgICAgIFwibm8tcHJvbWlzZS1leGVjdXRvci1yZXR1cm5cIjogXCJlcnJvclwiLFxuICAgICAgXCJuby1yZXR1cm4tYXNzaWduXCI6IFtcImVycm9yXCIsIFwiYWx3YXlzXCJdLFxuICAgICAgXCJuby1zZWxmLWNvbXBhcmVcIjogXCJlcnJvclwiLFxuICAgICAgXCJuby10aHJvdy1saXRlcmFsXCI6IFwiZXJyb3JcIixcbiAgICAgIFwibm8tdW5tb2RpZmllZC1sb29wLWNvbmRpdGlvblwiOiBcImVycm9yXCIsXG4gICAgICBcIm5vLXVucmVhY2hhYmxlLWxvb3BcIjogXCJlcnJvclwiLFxuICAgICAgXCJuby11bnVzZWQtZXhwcmVzc2lvbnNcIjogXCJlcnJvclwiLFxuICAgICAgXCJuby11c2VsZXNzLWFzc2lnbm1lbnRcIjogXCJlcnJvclwiLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBmaWxlczogW1wiKiovKi5tanNcIiwgXCJiaW4vKi5janNcIiwgXCIucG5wbWZpbGUuY2pzXCJdLFxuICAgIGxhbmd1YWdlT3B0aW9uczogeyBnbG9iYWxzOiBnbG9iYWxzLm5vZGUgfSxcbiAgfSxcbiAge1xuICAgIGZpbGVzOiBbXCJzcmMvKiovKi50c1wiLCBcInNjcmlwdHMvKiovKi5tdHNcIiwgXCJ0ZXN0cy8qKi8qLm10c1wiLCBcImV4YW1wbGVzLyoqL3NjcmlwdHMvKi5tdHNcIiwgXCJiaW4vKi5jdHNcIiwgXCIqLm10c1wiXSxcbiAgICBleHRlbmRzOiBbLi4udHNlc2xpbnQuY29uZmlncy5zdHJpY3RUeXBlQ2hlY2tlZCwgLi4udHNlc2xpbnQuY29uZmlncy5zdHlsaXN0aWNUeXBlQ2hlY2tlZF0sXG4gICAgbGFuZ3VhZ2VPcHRpb25zOiB7IHBhcnNlck9wdGlvbnM6IHsgcHJvamVjdFNlcnZpY2U6IHRydWUsIHRzY29uZmlnUm9vdERpcjogaW1wb3J0Lm1ldGEuZGlybmFtZSB9IH0sXG4gICAgcnVsZXM6IHtcbiAgICAgIFwiQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVwiOiBcImVycm9yXCIsXG4gICAgICBcIkB0eXBlc2NyaXB0LWVzbGludC9uby11bnNhZmUtZW51bS1hc3NpZ25tZW50XCI6IFwiZXJyb3JcIixcbiAgICAgIFwiQHR5cGVzY3JpcHQtZXNsaW50L3N3aXRjaC1leGhhdXN0aXZlbmVzcy1jaGVja1wiOiBcImVycm9yXCIsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGZpbGVzOiBbXCJiaW4vKi5jdHNcIl0sXG4gICAgLy8gQ29tbW9uSlMgYm9vdHN0cmFwIHNvdXJjZXMgdXNlIFR5cGVTY3JpcHQncyB0eXBlZCBpbXBvcnQgYXNzaWdubWVudHMuXG4gICAgcnVsZXM6IHsgXCJAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzXCI6IFtcImVycm9yXCIsIHsgYWxsb3dBc0ltcG9ydDogdHJ1ZSB9XSB9LFxuICB9LFxuICB7XG4gICAgZmlsZXM6IFtcInRlc3RzLyoqLyoubXRzXCJdLFxuICAgIHJ1bGVzOiB7XG4gICAgICAvLyBGb2N1c2VkIHRlc3RzIGNhbiBzaWxlbnRseSByZWR1Y2UgdGhlIGV4ZWN1dGVkIHN1aXRlLlxuICAgICAgXCJuby1yZXN0cmljdGVkLXByb3BlcnRpZXNcIjogW1xuICAgICAgICBcImVycm9yXCIsXG4gICAgICAgIC4uLltcInRlc3RcIiwgXCJpdFwiLCBcImRlc2NyaWJlXCJdLm1hcCgob2JqZWN0KSA9PiAoe1xuICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICBwcm9wZXJ0eTogXCJvbmx5XCIsXG4gICAgICAgICAgbWVzc2FnZTogXCJSZW1vdmUgZm9jdXNlZCB0ZXN0cyBiZWZvcmUgY29tbWl0dGluZy5cIixcbiAgICAgICAgfSkpLFxuICAgICAgXSxcbiAgICB9LFxuICB9LFxuICBlc2xpbnRDb25maWdQcmV0dGllcixcbik7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLFFBQVE7QUFDZixTQUFTLG9CQUFvQjtBQUM3QixPQUFPLDBCQUEwQjtBQUNqQyxPQUFPLGFBQWE7QUFDcEIsT0FBTyxjQUFjO0FBRXJCLElBQU8sd0JBQVE7QUFBQSxFQUNiLEdBQUcsUUFBUTtBQUFBLEVBQ1g7QUFBQSxJQUNFLGVBQWUsRUFBRSwrQkFBK0IsU0FBUywyQkFBMkIsUUFBUTtBQUFBO0FBQUEsSUFFNUYsT0FBTztBQUFBLE1BQ0wsUUFBUSxDQUFDLFNBQVMsUUFBUTtBQUFBLE1BQzFCLHlCQUF5QjtBQUFBLE1BQ3pCLG9CQUFvQjtBQUFBLE1BQ3BCLG1CQUFtQjtBQUFBLE1BQ25CLDhCQUE4QjtBQUFBLE1BQzlCLG9CQUFvQixDQUFDLFNBQVMsUUFBUTtBQUFBLE1BQ3RDLG1CQUFtQjtBQUFBLE1BQ25CLG9CQUFvQjtBQUFBLE1BQ3BCLGdDQUFnQztBQUFBLE1BQ2hDLHVCQUF1QjtBQUFBLE1BQ3ZCLHlCQUF5QjtBQUFBLE1BQ3pCLHlCQUF5QjtBQUFBLElBQzNCO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE9BQU8sQ0FBQyxZQUFZLGFBQWEsZUFBZTtBQUFBLElBQ2hELGlCQUFpQixFQUFFLFNBQVMsUUFBUSxLQUFLO0FBQUEsRUFDM0M7QUFBQSxFQUNBO0FBQUEsSUFDRSxPQUFPLENBQUMsZUFBZSxvQkFBb0Isa0JBQWtCLDZCQUE2QixhQUFhLE9BQU87QUFBQSxJQUM5RyxTQUFTLENBQUMsR0FBRyxTQUFTLFFBQVEsbUJBQW1CLEdBQUcsU0FBUyxRQUFRLG9CQUFvQjtBQUFBLElBQ3pGLGlCQUFpQixFQUFFLGVBQWUsRUFBRSxnQkFBZ0IsTUFBTSxpQkFBaUIsWUFBWSxRQUFRLEVBQUU7QUFBQSxJQUNqRyxPQUFPO0FBQUEsTUFDTCxzQ0FBc0M7QUFBQSxNQUN0QyxnREFBZ0Q7QUFBQSxNQUNoRCxrREFBa0Q7QUFBQSxJQUNwRDtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxPQUFPLENBQUMsV0FBVztBQUFBO0FBQUEsSUFFbkIsT0FBTyxFQUFFLHlDQUF5QyxDQUFDLFNBQVMsRUFBRSxlQUFlLEtBQUssQ0FBQyxFQUFFO0FBQUEsRUFDdkY7QUFBQSxFQUNBO0FBQUEsSUFDRSxPQUFPLENBQUMsZ0JBQWdCO0FBQUEsSUFDeEIsT0FBTztBQUFBO0FBQUEsTUFFTCw0QkFBNEI7QUFBQSxRQUMxQjtBQUFBLFFBQ0EsR0FBRyxDQUFDLFFBQVEsTUFBTSxVQUFVLEVBQUUsSUFBSSxDQUFDLFlBQVk7QUFBQSxVQUM3QztBQUFBLFVBQ0EsVUFBVTtBQUFBLFVBQ1YsU0FBUztBQUFBLFFBQ1gsRUFBRTtBQUFBLE1BQ0o7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJlc2xpbnQuY29uZmlnLm1qcyJ9
