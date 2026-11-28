import { defineConfig, type ViteUserConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { cpuBudget } from "./app/src/core/execution/checks/cpu-budget.mjs";
import { checkTestTimings, copyCheckTestTimings, prepareVitestCache } from "./scripts/vitest-build-cache.mjs";
import { transform } from "esbuild";

export default defineConfig((): ViteUserConfig => {
  const builds = process.env.WORKBENCH_BUILD_DIR ?? prepareVitestCache(import.meta.dirname);
  const coverage = Boolean(process.env.WORKBENCH_SUBPROCESS_COVERAGE);
  const privateCheck = process.env.WORKBENCH_CHECK_SCOPED === "1";
  const history = () => checkTestTimings(builds, coverage);
  let results: string | undefined;
  return {
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
      ...(privateCheck
        ? [
            {
              name: "workbench-test-timings",
              configResolved({ cacheDir }: { cacheDir: string }) {
                const path = join(cacheDir, "results.json");
                results = path;
                copyCheckTestTimings(history, () => path);
              },
            },
          ]
        : []),
    ],
    cacheDir: join(builds, coverage ? "vite-coverage" : "vite"),
    test: {
      fsModuleCachePath: process.env.VITEST_FS_MODULE_CACHE_PATH ?? join(builds, "vitest-modules"),
      // Also catches focused aliases and parameterized tests that bypass direct property linting.
      allowOnly: false,
      maxWorkers: Math.min(availableParallelism(), cpuBudget()),
      pool: "forks",
      isolate: true,
      reporters: [
        "default",
        "json",
        ...(privateCheck
          ? [
              {
                onTestRunEnd() {
                  const path = results;
                  if (path) copyCheckTestTimings(() => path, history);
                },
              },
            ]
          : []),
      ],
      outputFile: "coverage/tests.json",
      slowTestThreshold: 2000,
      include: ["app/test/**/*.test.mts"],
      setupFiles: ["app/test/setup.mts"],
      // Timing caps are advisory, including on slow hosts.
      testTimeout: 0,
      hookTimeout: 0,
      coverage: {
        provider: "v8",
        // Emitted helpers carry inline maps back to their authored TypeScript.
        include: [
          "app/src/**/*.{ts,tsx,mts,mjs}",
          "app/test/integration/consumers/*.ts",
          "app/test/integration/browser/*.mts",
          "scripts/**/*.{mts,mjs}",
          "bin/*.{js,mjs,cts}",
        ],
        // Bundled dependency maps must obey the same declared project-source scope.
        excludeAfterRemap: true,
        reportsDirectory: "coverage/unit",
        reporter: ["json"],
        // The final gate merges direct imports with instrumented CLI subprocesses.
        clean: false,
      },
    },
  };
});
