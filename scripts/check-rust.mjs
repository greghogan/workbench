import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

// Managed environments provide Rust's LLVM family as separate packages.
// rustup installations use their matching llvm-tools-preview component instead.
const env = { ...process.env };
if (env.GUIX_ENVIRONMENT || env.IN_NIX_SHELL) {
  env.LLVM_COV ??= "llvm-cov";
  env.LLVM_PROFDATA ??= "llvm-profdata";
}
const { coverage } = JSON.parse(readFileSync("workbench/quality.json", "utf8"));
const result = spawnSync(
  "cargo",
  [
    "llvm-cov",
    "nextest",
    "--all-targets",
    "--locked",
    "--no-fail-fast",
    "--fail-under-lines",
    String(coverage.lines),
    "--fail-under-functions",
    String(coverage.functions),
  ],
  { stdio: "inherit", env },
);
if (result.error) throw new Error(`Rust coverage failed: ${result.error}`);

mkdirSync("coverage", { recursive: true });
const report = spawnSync("cargo", ["llvm-cov", "report", "--json", "--output-path", "coverage/report.json"], {
  stdio: "inherit",
  env,
});
if (report.error || report.status !== 0)
  throw new Error(`Rust coverage report failed: ${report.error ?? report.status}`);
if (result.status !== 0) throw new Error(`Rust coverage failed: ${result.status}`);
