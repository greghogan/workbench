import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { runNativeChecks } = (await import(
  pathToFileURL(join(distribution, "scripts/native-c-checks.mjs")).href
)) as typeof import("../../../../scripts/native-c-checks.mjs");
await runNativeChecks("c", distribution, process.argv[2] ?? "");
