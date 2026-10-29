// Imported into the measured process, including the actual CLI startup process.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

// Node inherits --import in workers and forked children; only the selected main process publishes counters.
if (
  isMainThread &&
  (process.env.WORKBENCH_PROFILE_PID === undefined || process.env.WORKBENCH_PROFILE_PID === String(process.pid))
) {
  process.env.WORKBENCH_PROFILE_PID = String(process.pid);
  const before = process.resourceUsage(),
    start = performance.now(),
    path = process.env.WORKBENCH_PROFILE_MEASUREMENT;
  if (!path) throw new Error("The profiling measurement destination is required");
  process.once("exit", () => {
    const after = process.resourceUsage();
    writeFileSync(
      path,
      JSON.stringify({
        wallMs: performance.now() - start,
        cpuUserMs: (after.userCPUTime - before.userCPUTime) / 1000,
        cpuSystemMs: (after.systemCPUTime - before.systemCPUTime) / 1000,
        blockInputOps: after.fsRead - before.fsRead,
        blockOutputOps: after.fsWrite - before.fsWrite,
        maximumRssKiB: after.maxRSS,
      }),
      { flag: "wx", mode: 0o600 },
    );
  });
}
