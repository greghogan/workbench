// Generated from check.mts; edit the TypeScript source.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { cpuBudget } = await import(pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href);
const { writeRubyCoverage } = await import(pathToFileURL(join(distribution, "scripts/ruby-coverage.mjs")).href);
const role = process.argv[2];
if (!role) throw new Error("Specify the Ruby check role");
const source = process.cwd();
const build = resolve(process.env.WORKBENCH_BUILD_DIR ?? "build", "ruby");
const environment = {
  ...process.env,
  BUNDLE_GEMFILE: join(source, "Gemfile"),
  ...(process.env.WORKBENCH_DEPENDENCIES_DIR
    ? { BUNDLE_PATH: resolve(process.env.WORKBENCH_DEPENDENCIES_DIR, "ruby") }
    : {}),
  BUNDLE_APP_CONFIG: join(build, "bundle-config"),
  BUNDLE_USER_HOME: join(build, "bundle-user"),
  BUNDLE_FROZEN: role === "dependency-lock" ? "false" : "true",
  MAKEFLAGS: `-j${String(cpuBudget())}`,
  WORKBENCH_JOB_CPUS: String(cpuBudget()),
};
mkdirSync(build, { recursive: true });
function bundle(args, cwd = source) {
  const result = spawnSync(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "ruby-package-manager-exec", "--", ...args],
    {
      env: environment,
      cwd,
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Ruby ${String(role)} failed: ${String(result.error ?? result.status)}`);
}
switch (role) {
  case "dependency-lock":
    bundle([
      "lock",
      "--add-checksums",
      "--add-platform",
      "ruby",
      "--add-platform",
      "x64-mingw-ucrt",
      "--add-platform",
      "aarch64-linux",
      "--add-platform",
      "arm64-darwin",
    ]);
    break;
  case "setup":
    bundle(["install", "--jobs", String(cpuBudget())]);
    break;
  case "format":
  case "lint":
    bundle(["exec", "rubocop", "--parallel", "--cache-root", join(build, "rubocop")]);
    break;
  case "format-write":
    bundle(["exec", "rubocop", "--autocorrect", "--cache-root", join(build, "rubocop")]);
    break;
  case "type":
    bundle(["exec", "steep", "check", "--jobs", String(cpuBudget())]);
    break;
  case "test":
    bundle(["exec", "rake", "test"]);
    break;
  case "coverage":
    rmSync("coverage", { recursive: true, force: true });
    environment.WORKBENCH_COVERAGE = "true";
    environment.SIMPLECOV_RUN_ID = randomUUID();
    bundle(["exec", "rake", "test"]);
    writeRubyCoverage(JSON.parse(readFileSync("coverage/merged-result.json", "utf8")), source);
    break;
  case "build":
  case "release": {
    const output =
      role === "release"
        ? resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist")
        : join(build, "package");
    mkdirSync(output, { recursive: true });
    const specs = readdirSync(source).filter((name) => name.endsWith(".gemspec"));
    const [spec] = specs;
    if (specs.length !== 1 || !spec) throw new Error("Ruby packaging requires one root gemspec");
    const artifact = join(build, "reference.gem");
    const stage = join(build, "gem-source");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    for (const path of ["lib", "sig", "bin", "README.md", "LICENSE", spec])
      cpSync(join(source, path), join(stage, path), { recursive: true });
    const permissions = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          chmodSync(path, 493);
          permissions(path);
        } else chmodSync(path, 420);
      }
    };
    permissions(stage);
    chmodSync(join(stage, "bin/count"), 493);
    bundle(["exec", "gem", "build", spec, "--strict", "--output", artifact], stage);
    if (!existsSync(artifact)) throw new Error("Ruby build omitted its gem");
    cpSync(artifact, join(output, "workbench-ruby-reference-0.1.0.gem"));
    break;
  }
  default:
    throw new Error(`Unknown Ruby check: ${role}`);
}
