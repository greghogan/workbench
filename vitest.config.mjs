import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir:
    process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR
      ? `${process.env.WORKBENCH_BUILD_DIR}/vite`
      : "node_modules/.vite",
  test: {
    reporters: ["default", "json"],
    outputFile: "coverage/tests.json",
    slowTestThreshold: 2000,
    include: ["tests/**/*.test.mjs"],
    setupFiles: ["tests/setup.mjs"],
    // Timing caps are advisory, including on slow hosts.
    testTimeout: 0,
    hookTimeout: 0,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage/unit",
      reporter: ["json"],
      // The final gate merges direct imports with instrumented CLI subprocesses.
      clean: false,
    },
  },
});
