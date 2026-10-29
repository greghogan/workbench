import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { decodeMeasurement } from "../scripts/profile-model.mjs";

test("profiling a process with worker threads and forked children publishes only its own measurement", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-profile-capture-"));
  try {
    const entry = join(temporary, "main.mjs"),
      child = join(temporary, "child.mjs"),
      measurement = join(temporary, "measurement.json");
    writeFileSync(child, "console.log('child completed');\n");
    writeFileSync(
      entry,
      `import {Worker} from 'node:worker_threads'; import {fork} from 'node:child_process'; import {once} from 'node:events'; const worker = new Worker(new URL('./child.mjs',import.meta.url)); const child = fork(${JSON.stringify(child)}); const results = await Promise.all([once(worker,'exit'),once(child,'exit')]); if(results.some(([status])=>status!==0)) throw new Error('Child failed');\n`,
    );
    const env = { ...process.env, WORKBENCH_PROFILE_MEASUREMENT: measurement };
    Reflect.deleteProperty(env, "WORKBENCH_PROFILE_PID");
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(resolve("scripts/profile-measurement.mjs")).href, entry],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(decodeMeasurement(JSON.parse(readFileSync(measurement, "utf8"))).maximumRssKiB).toBeGreaterThan(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
