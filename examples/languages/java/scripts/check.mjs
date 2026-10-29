// Generated from check.mts; edit the TypeScript source.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { runJavaCheckCommand } = await import(pathToFileURL(resolve(distribution, "scripts/java-check.mjs")).href);
await runJavaCheckCommand({ distribution, role: process.argv[2] ?? "", artifact: "count.jar" });
