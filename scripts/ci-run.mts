import { isStringArray, required, record, string, capturedText } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilerCompatibilityRoles } from "./ci-contract.mjs";

const roots: unknown = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!isStringArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
const distribution = process.env.WORKBENCH_DISTRIBUTION_ROOT ?? workspace;
const mode = required(process.argv[2], "Missing CI mode");
function run(command: string, args: string[], cwd = workspace, env = process.env, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
  return capturedText(result.stdout);
}
const cli = (...args: string[]) => run(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
const toolchain = process.env.CHECK_TOOLCHAIN ? ["--toolchain", process.env.CHECK_TOOLCHAIN] : [];
let failed = false;
const successful = [];
for (const [index, root] of roots.entries()) {
  console.log(`::group::${mode}: ${root}`);
  try {
    if (["native", "native-install", "native-check"].includes(mode)) {
      // Miri is an explicitly selected manual check, not part of the ordinary CI stage.
      if (mode !== "native-check") cli("tools", "install", "--path", root, "--exclude-tool", "miri", ...toolchain);
      if (mode !== "native-install")
        cli("check", "--stage", "ci", "--path", root, "--environment", "native", ...toolchain);
    } else if (mode === "release") {
      cli("check", "--role", "release", "--path", root, "--environment", "native", ...toolchain);
      cli("check", "--role", "release-verify", "--path", root, "--environment", "native", ...toolchain);
      const artifacts = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "release-artifacts");
      mkdirSync(artifacts, { recursive: true });
      const tar =
        process.platform === "win32"
          ? join(required(process.env.SystemRoot, "SystemRoot is required"), "System32", "tar.exe")
          : "tar";
      const paths = record(
        JSON.parse(
          run(
            process.execPath,
            [join(distribution, "bin/workbench.mjs"), "paths", "--path", root, "--environment", "native", ...toolchain],
            workspace,
            process.env,
            true,
          ),
        ),
        "Invalid project paths",
      );
      const directory = string(
        record(paths.variables, "Missing path variables").WORKBENCH_DIST_DIR,
        "Missing release directory",
      );
      run(tar, ["-czf", join(artifacts, `${String(index)}.tar.gz`), "-C", directory, "."]);
      writeFileSync(join(artifacts, `${String(index)}.txt`), `${root}\n`);
    } else if (mode === "environment") {
      cli(
        "check",
        "--stage",
        "ci",
        "--path",
        root,
        "--environment",
        required(process.env.CHECK_ENVIRONMENT, "CHECK_ENVIRONMENT is required"),
      );
    } else if (mode === "compatibility" || mode === "python") {
      const runtime = mode === "python" ? "python" : process.env.RUNTIME;
      const version = mode === "python" ? process.env.PYTHON_VERSION : process.env.RUNTIME_VERSION;
      if (!runtime || !["node", "python", "go", "rust", "java", "ruby", "php"].includes(runtime) || !version)
        throw new Error("compatibility requires a runtime and version");
      run(
        process.execPath,
        [join(distribution, "bin/workbench.mjs"), "compatibility-exec", root, runtime, version, "--checks"],
        workspace,
        { ...process.env, CHECK_ROOTS: JSON.stringify([root]) },
      );
    } else if (mode === "compiler" || mode === "compiler-install") {
      const selection = [
        "--compiler",
        required(process.env.COMPILER, "COMPILER is required"),
        "--compiler-version",
        required(process.env.COMPILER_VERSION, "COMPILER_VERSION is required"),
      ];
      if (mode === "compiler-install") cli("tools", "install", "--path", root, ...selection);
      else {
        const roles: unknown = JSON.parse(process.env.CHECK_ROLES ?? "[]");
        if (!isStringArray(roles) || !roles.length || roles.some((role) => !compilerCompatibilityRoles.includes(role)))
          throw new Error("CHECK_ROLES must list compiler compatibility roles");
        for (const role of roles) cli("check", "--role", role, "--path", root, "--environment", "native", ...selection);
      }
    } else throw new Error(`unknown CI mode: ${mode}`);
    successful.push(root);
  } catch (error) {
    failed = true;
    console.error(`::error::${root}: ${errorMessage(error)}`);
  } finally {
    console.log("::endgroup::");
  }
}
if (["native", "native-install", "native-check", "release"].includes(mode) && process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `roots=${JSON.stringify(successful)}\n`);
if (failed) process.exitCode = 1;
