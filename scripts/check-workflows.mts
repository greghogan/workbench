import { ciActionPins, workflowPaths } from "./ci-actions.mjs";
import { actionPins } from "./maintenance/syntax.mjs";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Explicit paths let actionlint validate exported checkouts without Git metadata.
const directory = ".github/workflows";
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => join(directory, name));
if (!files.length) throw new Error("No GitHub workflows to validate");
const authority = ciActionPins(process.cwd());
for (const file of workflowPaths(process.cwd()))
  for (const pin of actionPins(readFileSync(file, "utf8"), true)) {
    const expected = authority[pin.name];
    if (expected && (expected.revision !== pin.revision || expected.version !== pin.version))
      throw new Error(`${file}: action pin differs from scripts/ci-actions.json: ${pin.name}`);
  }
const config = [".github/actionlint.yaml", ".github/actionlint.yml"].find(existsSync);
const result = spawnSync("actionlint", [...(config ? ["-config-file", config] : []), ...files], { stdio: "inherit" });
if (result.error || result.status !== 0)
  throw new Error(`Workflow validation failed: ${String(result.error ?? result.status)}`);
