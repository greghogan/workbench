import { pathToFileURL } from "node:url";
import { clipped } from "./diagnostic-text.mjs";
import { parseArgs } from "node:util";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { availableParallelism, platform, release, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { workingReviewTree } from "../src/git-snapshot.ts";
import { readBoundedFile } from "../src/file-reads.ts";
import { withEngineeringRun, withEngineeringReport } from "./engineering-run.mjs";
import { processFailure } from "./process-outcome.mjs";
import { writeAtomic } from "./file-publication.mjs";
import {
  profileCases,
  isProfileCase,
  decodeMeasurement,
  type ProfileResult,
  type ProfileSample,
} from "./profile-model.mjs";

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    output: { type: "string" },
  },
});
const selected = [...new Set(values.case ?? profileCases)],
  samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20 || !selected.length || !selected.every(isProfileCase))
  throw new Error("Select named profiling cases and 1–20 unprofiled samples");
const parent =
  values.output ?? (process.env.WORKBENCH_BUILD_DIR ? join(process.env.WORKBENCH_BUILD_DIR, "profiles") : undefined);
if (!parent) throw new Error("Use a configured Workbench shell/check or select --output for profiling captures");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(resolve(parent), "capture-")),
  results: ProfileResult[] = [];
const report = {
  status: "running" as "running" | "passed" | "failed",
  error: "",
  schema_version: 1,
  sourceTree: workingReviewTree(process.cwd()),
  node: process.version,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  cpus: availableParallelism(),
  results,
  limits:
    "Samples use fresh processes and existing filesystem caches. Resource counters exclude subprocesses; block counters do not count all network-filesystem requests. Profiled timings are separate from unprofiled samples. No speedup is claimed.",
};
const save = () => {
  writeAtomic(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
};
console.log(`Profiling evidence: ${join(directory, "report.json")}`);
await withEngineeringReport(report, save, async () => {
  await withEngineeringRun(resolve(parent), "profile", async (job) => {
    for (const kind of selected) {
      const result: ProfileResult = { kind, samples: [] };
      results.push(result);
      for (let index = 0; index <= samples; index++) {
        const profiled = index === samples,
          destination = join(directory, kind, String(index));
        mkdirSync(destination, { recursive: true });
        const measurementFile = join(destination, "measurement.json"),
          start = performance.now();
        const sample: ProfileSample = { profiled, wallMs: 0, status: "failed", captures: [] };
        result.samples.push(sample);
        try {
          const entry = kind === "startup" ? ["bin/workbench.mjs", "--help"] : ["scripts/profile-case.mjs", kind];
          const outcome = await job.command(
            process.execPath,
            [
              "--import",
              pathToFileURL(resolve("scripts/profile-measurement.mjs")).href,
              ...(profiled
                ? ["--cpu-prof", `--cpu-prof-dir=${destination}`, "--heap-prof", `--heap-prof-dir=${destination}`]
                : []),
              ...entry,
            ],
            {
              capture: true,
              limit: 4 * 1024 * 1024,
              env: {
                ...process.env,
                WORKBENCH_EPHEMERAL_CHECKOUT: "1",
                WORKBENCH_PROFILE_MEASUREMENT: measurementFile,
                WORKBENCH_PROFILE_PID: undefined,
              },
            },
          );
          sample.process = { status: outcome.status, signal: outcome.signal };
          const failure = processFailure(`Workbench profiling: ${kind}`, outcome, outcome);
          if (failure) throw failure;
          sample.measurement = decodeMeasurement(
            JSON.parse(readBoundedFile(measurementFile, 65536, "profiling measurement").toString("utf8")),
          );
          if (
            profiled &&
            (!readdirSync(destination).some((path) => path.endsWith(".cpuprofile")) ||
              !readdirSync(destination).some((path) => path.endsWith(".heapprofile")))
          )
            throw new Error("Node produced no complete CPU/heap profiling evidence");
          sample.status = "passed";
        } catch (failure) {
          sample.error = clipped(String(failure)).text;
          throw failure;
        } finally {
          sample.wallMs = performance.now() - start;
          sample.captures = readdirSync(destination).map((name) => ({
            path: relative(directory, join(destination, name)),
            bytes: statSync(join(destination, name)).size,
          }));
          save();
        }
      }
    }
    if (workingReviewTree(process.cwd()) !== report.sourceTree)
      throw new Error("Profiling source changed during capture; results identify the starting snapshot only");
  });
});
