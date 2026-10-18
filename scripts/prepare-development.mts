import { record, string } from "./values.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { openSync, closeSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Project-owned recipe: retain native check inputs, then prove fresh offline execution.
const [builder, option] = process.argv.slice(2);
if ((builder !== "native" && builder !== "nix" && builder !== "guix") || (option && option !== "--verify"))
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify]");
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin/workbench.mjs");
const verify = option === "--verify";
if (!verify && builder !== "native")
  throw new Error(
    "Managed images are assembled by scripts/prepare-managed-development.mjs from their declared closures",
  );
function run(command: string, args: string[], cwd = root) {
  const quiet = !verify && args[1] === "tools" && args[2] === "install";
  const logs = quiet ? mkdtempSync(join(tmpdir(), "workbench-tool-install-")) : undefined;
  const log = logs ? join(logs, "install.log") : undefined;
  let output;
  if (quiet) console.log(`Preparing verified native tools (${args.slice(3).join(" ")})...`);
  try {
    output = log ? openSync(log, "w") : undefined;
    const child = spawnSync(command, args, {
      cwd,
      stdio: output === undefined ? "inherit" : ["ignore", output, output],
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root },
    });
    if (child.error || child.status !== 0) {
      if (log) console.error(readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-100).join("\n"));
      throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
    }
  } finally {
    if (output !== undefined) closeSync(output);
    if (logs) rmSync(logs, { recursive: true, force: true });
  }
}
const matrix = record(
  JSON.parse(execFileSync(process.execPath, [cli, "check", "matrix"], { cwd: root, encoding: "utf8" })),
  "Invalid check matrix",
);
const include = record(matrix.native, "Missing native matrix").include;
if (!Array.isArray(include)) throw new Error("Missing native matrix entries");
const entries = include.map((value: unknown) => record(value, "Invalid matrix entry"));
const paths = [...new Set(entries.map((entry) => string(entry.path, "Missing matrix path")))];
if (!verify && builder === "native") {
  run(process.execPath, [cli, "tools", "install", "--exclude-tool", "miri"]);
  for (const name of [
    ...new Set(entries.flatMap((entry) => (entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))),
  ])
    run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
}
for (const path of paths) {
  console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
  const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
  run(process.execPath, [cli, ...selection, "--role", "build"]);
  if (builder === "native") {
    const plan = record(
      JSON.parse(
        execFileSync(process.execPath, [cli, ...selection, "--stage", "ci", "--json"], {
          cwd: root,
          encoding: "utf8",
        }),
      ),
      "Invalid check plan",
    );
    // Resolve the configured CI variants, including coverage and analysis tools missed by ordinary build/test.
    // Advisory databases are live inputs, so query them in CI rather than freezing them into the image.
    if (!Array.isArray(plan.selected)) throw new Error("Missing selected checks");
    const roles = [
      ...new Set(
        plan.selected.map((check: unknown) => string(record(check, "Invalid check").role, "Missing check role")),
      ),
    ].filter((role) => !["setup", "build", "advisory"].includes(role));
    if (roles.length)
      run(process.execPath, [cli, ...selection, "--stage", "ci", ...roles.flatMap((role) => ["--role", role])]);
  } else run(process.execPath, [cli, ...selection, "--role", "test"]);
  console.log("::endgroup::");
}

if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
  const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
  retainPnpmMetadata(root, cli, paths);
}
