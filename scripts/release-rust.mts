import { capturedText } from "./values.mjs";
import { record, string, isRecord, isStringArray } from "./values.mjs";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cpuBudget } from "./cpu-budget.mjs";

const { values } = parseArgs({ options: { target: { type: "string" } } });
const root = process.cwd();
const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CARGO_BUILD_JOBS: String(cpuBudget()),
  RUST_TEST_THREADS: String(cpuBudget()),
};
function run(command: string, args: string[], capture = false) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Rust release: ${command} ${args[0] ?? ""} failed: ${String(result.error ?? result.status)}`);
  return capturedText(result.stdout);
}

const compiler = run("rustc", ["-vV"], true);
const host = /^host: (.+)$/m.exec(compiler)?.[1];
const compilerVersion = /^rustc (\d+\.\d+\.\d+)\b/.exec(compiler)?.[1];
if (!host || !compilerVersion) throw new Error("Rust release: rustc did not report its version and host target");
const target = values.target ?? host;
const toolchain = `+${compilerVersion}`;
let recipe:
  { targets: Record<string, Record<string, unknown>>; cross_version: string; cross_revision: string } | undefined;
if (values.target) {
  const value = record(JSON.parse(readFileSync(join(root, "release-musl.json"), "utf8")), "Invalid musl recipe");
  recipe = {
    targets: Object.fromEntries(
      Object.entries(record(value.targets, "Missing musl targets")).map(([key, target]) => [
        key,
        record(target, "Invalid musl target"),
      ]),
    ),
    cross_version: string(value.cross_version, "Missing cross version"),
    cross_revision: string(value.cross_revision, "Missing cross revision"),
  };
  const selected = recipe.targets[target];
  if (selected?.platform !== `${process.platform}-${process.arch}`)
    throw new Error(`Rust release: ${target} requires its native Linux architecture builder; no emulation`);
  if (process.env.WORKBENCH_SHELL_ENVIRONMENT && process.env.WORKBENCH_SHELL_ENVIRONMENT !== "native")
    throw new Error(
      "Rust release: musl profiles require the native builder; managed releases retain their own tool authority",
    );
  // Portable recipes must not inherit host-specific optimization or linker settings.
  const buildOptions = env.CROSS_BUILD_OPTS;
  for (const name of Object.keys(env))
    if (
      /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_(?:LINKER|RUNNER|RUSTFLAGS)|CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS|CROSS_.*)$/.test(
        name,
      )
    )
      Reflect.deleteProperty(env, name);
  // Keep cross's explicit Docker build transport options (for example local host networking).
  if (buildOptions) env.CROSS_BUILD_OPTS = buildOptions;
  env.CROSS_CONTAINER_ENGINE = "docker";
  env.RUSTFLAGS = `-Ctarget-cpu=${process.arch === "x64" ? "x86-64" : "generic"} -Ctarget-feature=+crt-static`;
  const enginePlatform = run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], true).trim();
  if (enginePlatform !== `linux/${process.arch === "x64" ? "amd64" : "arm64"}`)
    throw new Error(`Rust release: Docker engine ${enginePlatform} requires emulation`);
  const reported = /^cross (\S+)(?: \(([0-9a-f]{7,40}) [^)]+\))?/m.exec(run("cross", [toolchain, "--version"], true));
  const version = reported?.[1];
  if (version !== recipe.cross_version)
    throw new Error(`Rust release: expected cross ${recipe.cross_version}, found ${version ?? "unknown"}`);
  if (!reported?.[2] || !recipe.cross_revision.startsWith(reported[2]))
    throw new Error(
      `Rust release: expected cross revision ${recipe.cross_revision}, found ${reported?.[2] ?? "unknown"}`,
    );
}
delete env.CARGO_BUILD_TARGET;
const runner = values.target ? "cross" : "cargo";
const prefix = values.target ? [toolchain] : [];
const build = resolve(process.env.CARGO_TARGET_DIR ?? join(process.env.WORKBENCH_BUILD_DIR ?? root, "target"));
const selection = ["--release", "--locked", "--target", target, "--target-dir", build];
run(runner, [...prefix, "test", "--workspace", "--all-targets", "--no-fail-fast", ...selection]);
run(runner, [...prefix, "test", "--workspace", "--doc", ...selection]);
const messages = run(
  runner,
  [...prefix, "build", "--workspace", "--bins", "--message-format=json-render-diagnostics", ...selection],
  true,
);
const binaries = new Set<string>();
for (const line of messages.split("\n").filter(Boolean)) {
  if (!line.startsWith("{")) {
    console.log(line);
    continue;
  }
  const event = record(JSON.parse(line), "Invalid Rust build event");
  if (event.reason === "compiler-message" && isRecord(event.message) && typeof event.message.rendered === "string")
    process.stderr.write(event.message.rendered);
  if (
    event.reason === "compiler-artifact" &&
    isRecord(event.target) &&
    isStringArray(event.target.kind) &&
    event.target.kind.includes("bin") &&
    typeof event.executable === "string"
  )
    binaries.add(basename(event.executable));
}
if (!binaries.size) throw new Error("Rust release: no executable artifacts were produced");

mkdirSync(dirname(output), { recursive: true });
const staging = mkdtempSync(join(dirname(output), ".rust-release-"));
try {
  for (const name of binaries) copyFileSync(join(build, target, "release", name), join(staging, name));
  if (existsSync(join(root, "LICENSE"))) copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  writeFileSync(
    join(staging, "rust-release.json"),
    JSON.stringify(
      {
        target,
        binaries: [...binaries].sort(),
        ...(recipe
          ? { ...recipe.targets[target], cross_version: recipe.cross_version, cross_revision: recipe.cross_revision }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  run(process.execPath, [join(root, "scripts/release-verify.mjs"), staging, root]);
  mkdirSync(output, { recursive: true });
  // Verification finishes before any accepted file is replaced. Each replacement is an atomic rename.
  for (const name of readdirSync(staging)) renameSync(join(staging, name), join(output, name));
  console.log(`Prepared verified Rust release (${target}): ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
