import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { cpuBudget } from "../app/src/core/execution/checks/cpu-budget.mjs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
// Type-aware workers each need their own TypeScript project service.
const workers = Math.min(4, cpuBudget(), Math.floor(process.availableMemory() / (2 * 1024 ** 3)));
const cancellation = processCancellation();
try {
  const result = await runOwnedChild(
    process.execPath,
    [
      "--max-old-space-size=4096",
      "node_modules/eslint/bin/eslint.js",
      "--config",
      "eslint.config.mjs",
      "--concurrency",
      workers > 1 ? String(workers) : "off",
      "--max-warnings",
      "0",
      "app/src",
      "app/test",
      "scripts",
      "bin",
      "examples/**/scripts/*.{mjs,mts}",
      ".pnpmfile.cjs",
      "eslint.config.mts",
      "vitest.config.mts",
    ],
    { cwd: root, env: process.env, signal: cancellation.signal },
  );
  if (result.error || result.status === null) {
    const failure = processFailure("TypeScript lint", result);
    if (failure) console.error(failure.message);
    process.exitCode = 1;
  } else process.exitCode = result.status;
} finally {
  cancellation.close();
}
