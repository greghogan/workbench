import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Explicit paths let actionlint validate exported checkouts without Git metadata.
const directory = ".github/workflows";
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => join(directory, name));
if (!files.length) throw new Error("No GitHub workflows to validate");
const config = [".github/actionlint.yaml", ".github/actionlint.yml"].find(existsSync);
const result = spawnSync("actionlint", [...(config ? ["-config-file", config] : []), ...files], { stdio: "inherit" });
if (result.error || result.status !== 0)
  throw new Error(`Workflow validation failed: ${String(result.error ?? result.status)}`);
