import { required, record, records, string, strings, stringRecord } from "../app/src/core/runtime/values.mjs";
import type { CacheInspectionRequest } from "../app/src/core/execution/ci/ci-cache-inspection.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ciCacheEnvironment } from "../app/src/core/execution/ci/support/ci-layout.mjs";

const distribution = resolve(import.meta.dirname, "..");

if (import.meta.main) {
  const env = process.env;
  const rawTarget = record(JSON.parse(env.CACHE_TARGET ?? "{}"), "Invalid cache target");
  const target: CacheInspectionRequest["target"] = {};
  for (const key of ["runtime", "version", "environment"] as const)
    if (rawTarget[key] !== undefined && rawTarget[key] !== null)
      target[key] = string(rawTarget[key], "Invalid cache target field");
  if (rawTarget.paths !== undefined) target.paths = strings(rawTarget.paths, "Invalid cache roots");
  if (rawTarget.selections !== undefined)
    target.selections = records(rawTarget.selections, "Invalid cache selections").map((entry) => ({
      path: string(entry.path, "Invalid cache selection path"),
      ...(entry.toolchain === undefined ? {} : { toolchain: string(entry.toolchain, "Invalid cache toolchain") }),
    }));
  if (env.CHECK_CACHE_ENVIRONMENT) target.environment = env.CHECK_CACHE_ENVIRONMENT;

  const base = join(required(env.RUNNER_TEMP, "RUNNER_TEMP is required"), "workbench-ci");
  const data = join(base, "data");
  const cache = join(base, "cache");
  const variables = ciCacheEnvironment(cache, data, true);
  for (const path of [data, cache]) mkdirSync(path, { recursive: true });
  for (const [key, value] of Object.entries(variables))
    appendFileSync(required(env.GITHUB_ENV, "GITHUB_ENV is required"), `${key}=${value}\n`);
  const plan = stringRecord(
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(distribution, "bin/workbench.mjs"),
          "ci-cache-plan",
          JSON.stringify({ target, cache, compressionLevel: env.ZSTD_CLEVEL }),
        ],
        { encoding: "utf8", env: { ...env, ...variables }, maxBuffer: 16 * 1024 * 1024 },
      ),
    ),
    "Invalid hosted cache plan",
  );
  appendFileSync(
    required(env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required"),
    Object.entries(plan)
      .map(([key, value]) => `${key}<<WORKBENCH_CACHE\n${value}\nWORKBENCH_CACHE\n`)
      .join(""),
  );
  writeFileSync(join(base, "cache-plan.json"), JSON.stringify(plan, null, 2) + "\n");
}
