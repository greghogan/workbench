import { appendFileSync, existsSync, globSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Measurements are evidence, never a reason to skip verification or retain additional caches.
const directory = join(process.env.RUNNER_TEMP, "workbench-ci");
const path = join(directory, "cache-measurement.json");
if (process.argv[2] === "start") {
  writeFileSync(path, JSON.stringify({ started: new Date().toISOString() }));
} else if (process.argv[2] === "finish") {
  const start = JSON.parse(readFileSync(path, "utf8"));
  const plan = JSON.parse(readFileSync(join(directory, "cache-plan.json"), "utf8"));
  const bytes = (path) => {
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
            .flatMap((path) => (path.includes("*") ? globSync(path) : existsSync(path) ? [path] : [])),
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
        ...groups.map((group) => `| ${group.name} | ${group.bytes} |`),
        "",
      ].join("\n"),
    );
} else throw new Error("select start or finish");
