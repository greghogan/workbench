import { defineConfig, type ViteUserConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { cpuBudget } from "./scripts/cpu-budget.mjs";
import { transform } from "esbuild";

export default defineConfig((): ViteUserConfig => ({
  plugins: [
    {
      name: "workbench-commonjs-typescript",
      enforce: "pre",
      async transform(code: string, id: string) {
        if (!id.endsWith(".cts")) return;
        // Uncovered bootstrap sources need the same TypeScript transform as measured execution.
        const result = await transform(code, {
          loader: "ts",
          format: "cjs",
          target: "es2022",
          sourcefile: id,
          sourcemap: "external",
        });
        return { code: result.code, map: result.map };
      },
    },
  ],
  cacheDir:
    process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR
      ? `${process.env.WORKBENCH_BUILD_DIR}/vite`
      : "node_modules/.vite",
  test: {
    // Also catches focused aliases and parameterized tests that bypass direct property linting.
    allowOnly: false,
    maxWorkers: Math.min(availableParallelism(), cpuBudget()),
    pool: "forks",
    isolate: true,
    reporters: ["default", "json"],
    outputFile: "coverage/tests.json",
    slowTestThreshold: 2000,
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
      clean: false,
    },
  },
}));
