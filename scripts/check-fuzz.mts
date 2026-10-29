import { parseArgs } from "node:util";
import { readBoundedFile } from "../src/file-reads.ts";
import { processFailure } from "./process-outcome.mjs";
import { join, resolve } from "node:path";
import { decodePropertyOutcome, propertyTitles, isPropertyID, type PropertyOutcome } from "./document-properties.mjs";
import { withEngineeringRun } from "./engineering-run.mjs";
import { writeAtomic } from "./file-publication.mjs";
import { clipped } from "./diagnostic-text.mjs";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "10000" },
    seed: { type: "string", default: "20261103" },
    property: { type: "string", multiple: true },
    path: { type: "string" },
  },
});
const runs = Number(values.runs),
  seed = Number(values.seed),
  selected = [...new Set(values.property ?? Object.keys(propertyTitles))];
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  runs > 1_000_000 ||
  !Number.isSafeInteger(seed) ||
  !selected.length ||
  !selected.every(isPropertyID) ||
  (values.path !== undefined && (selected.length !== 1 || !/^(?:\d+:)*\d+$/.test(values.path)))
)
  throw new Error(
    "Select 1–1000000 property runs, an integer seed, known --property IDs, and --path only for one property",
  );
const parent = process.env.WORKBENCH_BUILD_DIR;
if (!parent) throw new Error("Run generated-input exploration through a configured Workbench check or shell");
const report = { schema_version: 1, runs, seed, outcomes: [] as PropertyOutcome[] },
  destination = join(parent, "fuzz-results.json");
await withEngineeringRun(parent, "property-exploration", async (job) => {
  for (const id of selected) {
    job.signal.throwIfAborted();
    let result: PropertyOutcome;
    try {
      const evidence = join(job.directory, `${id}.json`);
      const outcome = await job.command(
        process.execPath,
        [
          resolve("scripts/property-case.mjs"),
          "--property",
          id,
          "--runs",
          String(runs),
          `--seed=${String(seed)}`,
          "--output",
          evidence,
          ...(values.path === undefined ? [] : ["--path", values.path]),
        ],
        { capture: true },
      );
      const failure = processFailure(`Generated-input property ${id}`, outcome, outcome);
      if (failure) throw failure;
      const value: unknown = JSON.parse(readBoundedFile(evidence, 1024 * 1024, "property outcome").toString("utf8"));
      result = decodePropertyOutcome(value, id);
    } catch (error) {
      result = { id, status: "aborted", seed, error: clipped(String(error)).text };
    }
    report.outcomes.push(result);
    writeAtomic(destination, JSON.stringify(report, null, 2) + "\n");
    if (result.status !== "passed")
      throw new Error(
        `Property ${id} ${result.status}; evidence: ${destination}${result.path === undefined ? "" : `; replay with --property ${id} --seed=${String(result.seed)} --path ${result.path}`}`,
      );
    console.log(`Passed: ${id} — ${propertyTitles[id]}`);
  }
});
