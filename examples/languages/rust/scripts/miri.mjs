// Generated from miri.mts; edit the TypeScript source.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
const mode = process.argv[2];
if (!mode || !["portable", "avx2"].includes(mode) || !process.argv[3])
  throw new Error("Expected portable or avx2 and the pinned Workbench directory");
const result = spawnSync(
  process.execPath,
  [
    join(resolve(process.argv[3]), "bin/workbench.mjs"),
    "miri-exec",
    "--",
    "test",
    "--locked",
    "--target",
    "x86_64-unknown-linux-gnu",
    "--test",
    "count",
    "--",
    "--nocapture",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, RUSTFLAGS: `-Ctarget-feature=${mode === "avx2" ? "+" : "-"}avx2`, MIRIFLAGS: "" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
