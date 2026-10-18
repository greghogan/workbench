import { required, record, string, stringRecord } from "./values.mjs";

import { appendFileSync, existsSync, globSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Measurements are evidence, never a reason to skip verification or retain additional caches.
const directory = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "workbench-ci");
const path = join(directory, "cache-measurement.json");
if (process.argv[2] === "start") {
  writeFileSync(path, JSON.stringify({ started: new Date().toISOString() }));
} else if (process.argv[2] === "finish") {
  const start = {
    started: string(
      record(JSON.parse(readFileSync(path, "utf8")), "Invalid measurement").started,
      "Missing start time",
    ),
  };
  const plan = stringRecord(JSON.parse(readFileSync(join(directory, "cache-plan.json"), "utf8")), "Invalid cache plan");
  const bytes = (path: string): number => {
    const info = lstatSync(path);
    return info.isSymbolicLink()
      ? 0
      : info.isDirectory()
        ? readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0)
        : info.size;
  };
  const groups = Object.entries(plan)
    .filter(([key]) => /-(paths|path)$/.test(key))
    .map(([name, text]) => {
      const paths = [
        ...new Set(
          text
            .split("\n")
            .filter(Boolean)
            .flatMap((path: string) => (path.includes("*") ? globSync(path) : existsSync(path) ? [path] : [])),
        ),
      ].map((path) => resolve(path));
      const roots = paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(other + sep)));
      return { name, bytes: roots.reduce((sum, path) => sum + bytes(path), 0) };
    });
  const result = {
    ...start,
    finished: new Date().toISOString(),
    elapsed_seconds: (Date.now() - Date.parse(start.started)) / 1000,
    groups,
  };
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "\n## Cache footprint",
        "",
        "Elapsed time includes restore, setup, and checks; sizes are retained uncompressed file bytes.",
        "",
        "| Cache | Bytes |",
        "| --- | ---: |",
        ...groups.map((group) => `| ${group.name} | ${String(group.bytes)} |`),
        "",
      ].join("\n"),
    );
} else throw new Error("select start or finish");
