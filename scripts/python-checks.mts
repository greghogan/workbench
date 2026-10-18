import { required } from "./values.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const role = process.argv[2];
const managed = !!process.env.WORKBENCH_CHECK_INPUTS;
function run(args: string[], capture = false) {
  const child = spawnSync("uv", args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (child.error || child.status !== 0)
    throw new Error(`Python ${String(role)} failed: ${String(child.error ?? child.status)}`);
  return child.stdout;
}
if (role === "setup") {
  if (!managed) run(["sync", "--locked"]);
  else {
    // uv exports the committed graph and owns wheel selection, hash checks, extraction, and editable builds.
    // A locked sync uses registry URLs even with --find-links; the pip interface consumes the same hashes locally.
    const environment = resolve(process.env.UV_PROJECT_ENVIRONMENT ?? ".venv");
    if (!existsSync(join(environment, "pyvenv.cfg")))
      run(["venv", "--python", process.env.UV_PYTHON ?? "python3", environment]);
    const python = join(environment, "bin/python");
    const builds = resolve(process.env.WORKBENCH_BUILD_DIR ?? "build");
    mkdirSync(builds, { recursive: true });
    const requirements = join(builds, "managed-requirements.txt");
    writeFileSync(
      requirements,
      run(["export", "--locked", "--all-groups", "--no-emit-project", "--format", "requirements-txt"], true),
    );
    run([
      "pip",
      "sync",
      "--python",
      python,
      "--require-hashes",
      "--no-index",
      "--find-links",
      required(process.env.UV_FIND_LINKS, "Missing managed wheel directory"),
      requirements,
    ]);
    run([
      "pip",
      "install",
      "--python",
      python,
      "--no-deps",
      "--no-index",
      "--find-links",
      required(process.env.UV_FIND_LINKS, "Missing managed wheel directory"),
      "--editable",
      ".",
    ]);
  }
} else {
  const commands: Record<string, string[]> = {
    format: ["ruff", "format", "--check", "."],
    "format-write": ["ruff", "format", "."],
    lint: ["ruff", "check", "."],
    type: ["mypy", "src", "tests"],
    test: ["pytest", "--durations=10", "--durations-min=2"],
    coverage: ["pytest", "--cov", "--cov-report=term-missing", "--cov-report=json:coverage/report.json"],
  };
  const command = commands[role ?? ""];
  if (!command) throw new Error(`Unknown Python check role: ${String(role)}`);
  run(["run", "--locked", ...command]);
}
