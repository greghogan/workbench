import { resolve, join } from "node:path";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";

const root = resolve(import.meta.dirname, "..");
const cancellation = processCancellation();
try {
  for (const args of [
    [join(root, "bin/workbench.mjs"), "package-manager-exec", "--", "install", "--frozen-lockfile"],
    [join(root, "scripts/build-tooling.mts"), "--maintainers-only"],
  ]) {
    const result = await runOwnedChild(process.execPath, args, {
      cwd: root,
      env: process.env,
      signal: cancellation.signal,
    });
    const failure = processFailure("development setup", result);
    if (failure) throw failure;
  }
} finally {
  cancellation.close();
}
