import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilerCompatibilityRoles } from "./ci-contract.mjs";

const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
const distribution = process.env.WORKBENCH_DISTRIBUTION_ROOT ?? workspace;
const mode = process.argv[2];
function run(command, args, cwd = workspace, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
}
const cli = (...args) => run(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
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
        cli("checks", "run", "--stage", "ci", "--path", root, "--environment", "native", ...toolchain);
    } else if (mode === "release") {
      cli("checks", "run", "--role", "release", "--path", root, "--environment", "native", ...toolchain);
      cli("checks", "run", "--role", "release-verify", "--path", root, "--environment", "native", ...toolchain);
      const artifacts = join(process.env.RUNNER_TEMP, "release-artifacts");
      mkdirSync(artifacts, { recursive: true });
      const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
      run(tar, ["-czf", join(artifacts, `${index}.tar.gz`), "-C", join(workspace, root, "dist"), "."]);
      writeFileSync(join(artifacts, `${index}.txt`), `${root}\n`);
    } else if (mode === "environment") {
      cli("checks", "run", "--stage", "ci", "--path", root, "--environment", process.env.CHECK_ENVIRONMENT);
    } else if (mode === "compatibility" || mode === "python") {
      const runtime = mode === "python" ? "python" : process.env.RUNTIME;
      const version = mode === "python" ? process.env.PYTHON_VERSION : process.env.RUNTIME_VERSION;
      if (!["node", "python", "go", "rust", "java", "ruby", "php"].includes(runtime) || !version)
        throw new Error("compatibility requires a runtime and version");
      run(
        process.execPath,
        [join(distribution, "bin/workbench.mjs"), "compatibility-exec", root, runtime, version, "--checks"],
        workspace,
        { ...process.env, CHECK_ROOTS: JSON.stringify([root]) },
      );
    } else if (mode === "compiler" || mode === "compiler-install") {
      const selection = ["--compiler", process.env.COMPILER, "--compiler-version", process.env.COMPILER_VERSION];
      if (mode === "compiler-install") cli("tools", "install", "--path", root, ...selection);
      else {
        const roles = JSON.parse(process.env.CHECK_ROLES ?? "[]");
        if (!Array.isArray(roles) || !roles.length || roles.some((role) => !compilerCompatibilityRoles.includes(role)))
          throw new Error("CHECK_ROLES must list compiler compatibility roles");
        for (const role of roles)
          cli("checks", "run", "--role", role, "--path", root, "--environment", "native", ...selection);
      }
    } else throw new Error(`unknown CI mode: ${mode}`);
    successful.push(root);
  } catch (error) {
    failed = true;
    console.error(`::error::${root}: ${error.message}`);
  } finally {
    console.log("::endgroup::");
  }
}
if (["native", "native-install", "native-check", "release"].includes(mode) && process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `roots=${JSON.stringify(successful)}\n`);
if (failed) process.exitCode = 1;
