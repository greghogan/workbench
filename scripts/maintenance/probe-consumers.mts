import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { processFailure } from "../process-outcome.mjs";

// Disposable diagnostic: retain the real configured integration runner and environment boundary.
const selected =
  process.platform === "win32" ? ["--language", "c", "--language", "cpp", "--compiler", "mvsc"] : ["--language", "php"];
const outcome = spawnSync(
  process.execPath,
  ["scripts/check-consumers.mts", ...selected, "--output", join(process.cwd(), "coverage", "probe-consumers")],
  { stdio: "inherit" },
);
const failure = processFailure("native consumer diagnostic", { ...outcome, pid: outcome.pid });
if (failure) throw failure;
