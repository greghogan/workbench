import { defineConfig } from "vitest/config";

const budgets = [process.env.WORKBENCH_CPU_BUDGET, process.env.WORKBENCH_CPUS]
  .filter((value) => value !== undefined)
  .map(Number);

export default defineConfig({
  cacheDir:
    process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR
      ? `${process.env.WORKBENCH_BUILD_DIR}/vite`
      : "node_modules/.vite",
  test: {
    // Also catches focused aliases and parameterized tests that bypass direct property linting.
    allowOnly: false,
    ...(budgets.length ? { maxWorkers: Math.min(...budgets) } : {}),
    reporters: ["default", "json"],
    outputFile: "coverage/tests.json",
    include: ["test/**/*.test.ts"],
    slowTestThreshold: 2000,
    testTimeout: 0,
    hookTimeout: 0,
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
