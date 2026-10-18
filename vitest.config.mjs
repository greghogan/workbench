// Generated from vitest.config.mts; edit the TypeScript source.
import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { cpuBudget } from "./scripts/cpu-budget.mjs";
import { transform } from "esbuild";
var vitest_config_default = defineConfig(() => ({
  plugins: [
    {
      name: "workbench-commonjs-typescript",
      enforce: "pre",
      async transform(code, id) {
        if (!id.endsWith(".cts")) return;
        const result = await transform(code, {
          loader: "ts",
          format: "cjs",
          target: "es2022",
          sourcefile: id,
          sourcemap: "external"
        });
        return { code: result.code, map: result.map };
      }
    }
  ],
  cacheDir: process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR ? `${process.env.WORKBENCH_BUILD_DIR}/vite` : "node_modules/.vite",
  test: {
    // Also catches focused aliases and parameterized tests that bypass direct property linting.
    allowOnly: false,
    maxWorkers: Math.min(availableParallelism(), cpuBudget()),
    pool: "forks",
    isolate: true,
    reporters: ["default", "json"],
    outputFile: "coverage/tests.json",
    slowTestThreshold: 2e3,
    include: ["tests/**/*.test.mts"],
    setupFiles: ["tests/setup.mts"],
    // Timing caps are advisory, including on slow hosts.
    testTimeout: 0,
    hookTimeout: 0,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.mts", "bin/*.{js,mjs,cts}"],
      reportsDirectory: "coverage/unit",
      reporter: ["json"],
      // The final gate merges direct imports with instrumented CLI subprocesses.
      clean: false
    }
  }
}));
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZpdGVzdC5jb25maWcubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGRlZmluZUNvbmZpZywgdHlwZSBWaXRlVXNlckNvbmZpZyB9IGZyb20gXCJ2aXRlc3QvY29uZmlnXCI7XG5pbXBvcnQgeyBhdmFpbGFibGVQYXJhbGxlbGlzbSB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBjcHVCdWRnZXQgfSBmcm9tIFwiLi9zY3JpcHRzL2NwdS1idWRnZXQubWpzXCI7XG5pbXBvcnQgeyB0cmFuc2Zvcm0gfSBmcm9tIFwiZXNidWlsZFwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKCk6IFZpdGVVc2VyQ29uZmlnID0+ICh7XG4gIHBsdWdpbnM6IFtcbiAgICB7XG4gICAgICBuYW1lOiBcIndvcmtiZW5jaC1jb21tb25qcy10eXBlc2NyaXB0XCIsXG4gICAgICBlbmZvcmNlOiBcInByZVwiLFxuICAgICAgYXN5bmMgdHJhbnNmb3JtKGNvZGU6IHN0cmluZywgaWQ6IHN0cmluZykge1xuICAgICAgICBpZiAoIWlkLmVuZHNXaXRoKFwiLmN0c1wiKSkgcmV0dXJuO1xuICAgICAgICAvLyBVbmNvdmVyZWQgYm9vdHN0cmFwIHNvdXJjZXMgbmVlZCB0aGUgc2FtZSBUeXBlU2NyaXB0IHRyYW5zZm9ybSBhcyBtZWFzdXJlZCBleGVjdXRpb24uXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRyYW5zZm9ybShjb2RlLCB7XG4gICAgICAgICAgbG9hZGVyOiBcInRzXCIsXG4gICAgICAgICAgZm9ybWF0OiBcImNqc1wiLFxuICAgICAgICAgIHRhcmdldDogXCJlczIwMjJcIixcbiAgICAgICAgICBzb3VyY2VmaWxlOiBpZCxcbiAgICAgICAgICBzb3VyY2VtYXA6IFwiZXh0ZXJuYWxcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGNvZGU6IHJlc3VsdC5jb2RlLCBtYXA6IHJlc3VsdC5tYXAgfTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXSxcbiAgY2FjaGVEaXI6XG4gICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NUT1JBR0VfRVhURVJOQUwgIT09IFwiZmFsc2VcIiAmJiBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSXG4gICAgICA/IGAke3Byb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMRF9ESVJ9L3ZpdGVgXG4gICAgICA6IFwibm9kZV9tb2R1bGVzLy52aXRlXCIsXG4gIHRlc3Q6IHtcbiAgICAvLyBBbHNvIGNhdGNoZXMgZm9jdXNlZCBhbGlhc2VzIGFuZCBwYXJhbWV0ZXJpemVkIHRlc3RzIHRoYXQgYnlwYXNzIGRpcmVjdCBwcm9wZXJ0eSBsaW50aW5nLlxuICAgIGFsbG93T25seTogZmFsc2UsXG4gICAgbWF4V29ya2VyczogTWF0aC5taW4oYXZhaWxhYmxlUGFyYWxsZWxpc20oKSwgY3B1QnVkZ2V0KCkpLFxuICAgIHBvb2w6IFwiZm9ya3NcIixcbiAgICBpc29sYXRlOiB0cnVlLFxuICAgIHJlcG9ydGVyczogW1wiZGVmYXVsdFwiLCBcImpzb25cIl0sXG4gICAgb3V0cHV0RmlsZTogXCJjb3ZlcmFnZS90ZXN0cy5qc29uXCIsXG4gICAgc2xvd1Rlc3RUaHJlc2hvbGQ6IDIwMDAsXG4gICAgaW5jbHVkZTogW1widGVzdHMvKiovKi50ZXN0Lm10c1wiXSxcbiAgICBzZXR1cEZpbGVzOiBbXCJ0ZXN0cy9zZXR1cC5tdHNcIl0sXG4gICAgLy8gVGltaW5nIGNhcHMgYXJlIGFkdmlzb3J5LCBpbmNsdWRpbmcgb24gc2xvdyBob3N0cy5cbiAgICB0ZXN0VGltZW91dDogMCxcbiAgICBob29rVGltZW91dDogMCxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6IFwidjhcIixcbiAgICAgIGluY2x1ZGU6IFtcInNyYy8qKi8qLnRzXCIsIFwic2NyaXB0cy8qKi8qLm10c1wiLCBcImJpbi8qLntqcyxtanMsY3RzfVwiXSxcbiAgICAgIHJlcG9ydHNEaXJlY3Rvcnk6IFwiY292ZXJhZ2UvdW5pdFwiLFxuICAgICAgcmVwb3J0ZXI6IFtcImpzb25cIl0sXG4gICAgICAvLyBUaGUgZmluYWwgZ2F0ZSBtZXJnZXMgZGlyZWN0IGltcG9ydHMgd2l0aCBpbnN0cnVtZW50ZWQgQ0xJIHN1YnByb2Nlc3Nlcy5cbiAgICAgIGNsZWFuOiBmYWxzZSxcbiAgICB9LFxuICB9LFxufSkpO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxvQkFBeUM7QUFDbEQsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxpQkFBaUI7QUFFMUIsSUFBTyx3QkFBUSxhQUFhLE9BQXVCO0FBQUEsRUFDakQsU0FBUztBQUFBLElBQ1A7QUFBQSxNQUNFLE1BQU07QUFBQSxNQUNOLFNBQVM7QUFBQSxNQUNULE1BQU0sVUFBVSxNQUFjLElBQVk7QUFDeEMsWUFBSSxDQUFDLEdBQUcsU0FBUyxNQUFNLEVBQUc7QUFFMUIsY0FBTSxTQUFTLE1BQU0sVUFBVSxNQUFNO0FBQUEsVUFDbkMsUUFBUTtBQUFBLFVBQ1IsUUFBUTtBQUFBLFVBQ1IsUUFBUTtBQUFBLFVBQ1IsWUFBWTtBQUFBLFVBQ1osV0FBVztBQUFBLFFBQ2IsQ0FBQztBQUNELGVBQU8sRUFBRSxNQUFNLE9BQU8sTUFBTSxLQUFLLE9BQU8sSUFBSTtBQUFBLE1BQzlDO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFVBQ0UsUUFBUSxJQUFJLCtCQUErQixXQUFXLFFBQVEsSUFBSSxzQkFDOUQsR0FBRyxRQUFRLElBQUksbUJBQW1CLFVBQ2xDO0FBQUEsRUFDTixNQUFNO0FBQUE7QUFBQSxJQUVKLFdBQVc7QUFBQSxJQUNYLFlBQVksS0FBSyxJQUFJLHFCQUFxQixHQUFHLFVBQVUsQ0FBQztBQUFBLElBQ3hELE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxJQUNULFdBQVcsQ0FBQyxXQUFXLE1BQU07QUFBQSxJQUM3QixZQUFZO0FBQUEsSUFDWixtQkFBbUI7QUFBQSxJQUNuQixTQUFTLENBQUMscUJBQXFCO0FBQUEsSUFDL0IsWUFBWSxDQUFDLGlCQUFpQjtBQUFBO0FBQUEsSUFFOUIsYUFBYTtBQUFBLElBQ2IsYUFBYTtBQUFBLElBQ2IsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsU0FBUyxDQUFDLGVBQWUsb0JBQW9CLG9CQUFvQjtBQUFBLE1BQ2pFLGtCQUFrQjtBQUFBLE1BQ2xCLFVBQVUsQ0FBQyxNQUFNO0FBQUE7QUFBQSxNQUVqQixPQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFDRixFQUFFOyIsIm5hbWVzIjpbXSwiZmlsZSI6InZpdGVzdC5jb25maWcubWpzIn0=
