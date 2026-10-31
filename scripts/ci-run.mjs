// Generated from ci-run.mts; edit the TypeScript source.
import { isStringArray, required, record, string, capturedText, errorFrom } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compilerCompatibilityRoles } from "./ci-contract.mjs";
import { collectReports, reportState } from "./ci-reports.mjs";
const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!isStringArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
if (process.env.WORKBENCH_CI_TARGET && process.env.RUNNER_TEMP)
  process.env.WORKBENCH_STATE_HOME = join(
    process.env.WORKBENCH_DEVCONTAINER === "1" ? tmpdir() : process.env.RUNNER_TEMP,
    "workbench-state"
  );
const distribution = process.env.WORKBENCH_DISTRIBUTION_ROOT ?? workspace;
const mode = required(process.argv[2], "Missing CI mode");
function run(command, args, cwd = workspace, env = process.env, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
  return capturedText(result.stdout);
}
const cli = (...args) => run(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
cli("project", "add", workspace);
const toolchain = process.env.CHECK_TOOLCHAIN ? ["--toolchain", process.env.CHECK_TOOLCHAIN] : [];
let failed = false;
const successful = [];
for (const [index, root] of roots.entries()) {
  console.log(`::group::${mode}: ${root}`);
  try {
    if (["native", "native-install", "native-check"].includes(mode)) {
      if (mode !== "native-check") cli("tools", "install", "--path", root, "--exclude-tool", "miri", ...toolchain);
      if (mode !== "native-install")
        cli("check", "--stage", "ci", "--path", root, "--environment", "native", ...toolchain);
    } else if (mode === "integration") {
      const source = join(workspace, root, "build", "consumer-integration");
      const before = reportState(source);
      const destination = join(
        required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"),
        "consumer-integration",
        String(index)
      );
      let failure;
      try {
        cli("check", "--role", "integration", "--path", root, "--environment", "native", "--no-cache", ...toolchain);
      } catch (error) {
        failure = errorFrom(error);
      }
      try {
        collectReports(source, destination, before);
      } catch (error) {
        if (failure !== void 0)
          throw new AggregateError(
            [failure, error],
            `Integration check and report collection failed: ${errorMessage(failure)}; ${errorMessage(error)}`,
            { cause: error }
          );
        throw error;
      }
      if (failure !== void 0) throw failure;
    } else if (mode === "release") {
      cli("check", "--role", "release", "--path", root, "--environment", "native", ...toolchain);
      cli("check", "--role", "release-verify", "--path", root, "--environment", "native", ...toolchain);
      const artifacts = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "release-artifacts");
      mkdirSync(artifacts, { recursive: true });
      const tar = process.platform === "win32" ? join(required(process.env.SystemRoot, "SystemRoot is required"), "System32", "tar.exe") : "tar";
      const paths = record(
        JSON.parse(
          run(
            process.execPath,
            [join(distribution, "bin/workbench.mjs"), "paths", "--path", root, "--environment", "native", ...toolchain],
            workspace,
            process.env,
            true
          )
        ),
        "Invalid project paths"
      );
      const directory = string(
        record(paths.variables, "Missing path variables").WORKBENCH_DIST_DIR,
        "Missing release directory"
      );
      run(tar, ["-czf", join(artifacts, `${String(index)}.tar.gz`), "-C", directory, "."]);
      writeFileSync(join(artifacts, `${String(index)}.txt`), `${root}
`);
    } else if (mode === "environment") {
      cli(
        "check",
        "--stage",
        "ci",
        "--path",
        root,
        "--environment",
        required(process.env.CHECK_ENVIRONMENT, "CHECK_ENVIRONMENT is required")
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
        { ...process.env, CHECK_ROOTS: JSON.stringify([root]) }
      );
    } else if (mode === "compiler" || mode === "compiler-install") {
      const selection = [
        "--compiler",
        required(process.env.COMPILER, "COMPILER is required"),
        "--compiler-version",
        required(process.env.COMPILER_VERSION, "COMPILER_VERSION is required")
      ];
      if (mode === "compiler-install") cli("tools", "install", "--path", root, ...selection);
      else {
        const roles = JSON.parse(process.env.CHECK_ROLES ?? "[]");
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
  appendFileSync(process.env.GITHUB_OUTPUT, `roots=${JSON.stringify(successful)}
`);
if (failed) process.exitCode = 1;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJ1bi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNTdHJpbmdBcnJheSwgcmVxdWlyZWQsIHJlY29yZCwgc3RyaW5nLCBjYXB0dXJlZFRleHQsIGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2NpLXJlc3VsdHMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgY29tcGlsZXJDb21wYXRpYmlsaXR5Um9sZXMgfSBmcm9tIFwiLi9jaS1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IGNvbGxlY3RSZXBvcnRzLCByZXBvcnRTdGF0ZSB9IGZyb20gXCIuL2NpLXJlcG9ydHMubWpzXCI7XG5cbmNvbnN0IHJvb3RzOiB1bmtub3duID0gSlNPTi5wYXJzZShwcm9jZXNzLmVudi5DSEVDS19ST09UUyA/PyBcIltdXCIpO1xuaWYgKCFpc1N0cmluZ0FycmF5KHJvb3RzKSB8fCAhcm9vdHMubGVuZ3RoIHx8IHJvb3RzLnNvbWUoKHJvb3QpID0+IHR5cGVvZiByb290ICE9PSBcInN0cmluZ1wiIHx8ICFyb290KSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiQ0hFQ0tfUk9PVFMgbXVzdCBsaXN0IGNvbmZpZ3VyZWQgcm9vdHNcIik7XG5jb25zdCB3b3Jrc3BhY2UgPSBwcm9jZXNzLmN3ZCgpO1xuLy8gUmVnaXN0cmF0aW9uIHN0YXlzIHByaXZhdGUuIENvbnRhaW5lciBzdGF0ZSBiZWxvbmdzIHRvIGl0cyBkaXNwb3NhYmxlIGZpbGVzeXN0ZW0sXG4vLyBzbyBhIHRlcm1pbmF0ZWQgZ3Vlc3QgY2Fubm90IGxlYXZlIHVucmVhZGFibGUgcHJpdmF0ZSBkaXJlY3RvcmllcyBpbiB1cGxvYWRlZCByZXBvcnRzLlxuaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9DSV9UQVJHRVQgJiYgcHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVApXG4gIHByb2Nlc3MuZW52LldPUktCRU5DSF9TVEFURV9IT01FID0gam9pbihcbiAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfREVWQ09OVEFJTkVSID09PSBcIjFcIiA/IHRtcGRpcigpIDogcHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsXG4gICAgXCJ3b3JrYmVuY2gtc3RhdGVcIixcbiAgKTtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVCA/PyB3b3Jrc3BhY2U7XG5jb25zdCBtb2RlID0gcmVxdWlyZWQocHJvY2Vzcy5hcmd2WzJdLCBcIk1pc3NpbmcgQ0kgbW9kZVwiKTtcbmZ1bmN0aW9uIHJ1bihjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBjd2QgPSB3b3Jrc3BhY2UsIGVudiA9IHByb2Nlc3MuZW52LCBjYXB0dXJlID0gZmFsc2UpIHtcbiAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZW52LFxuICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICBzdGRpbzogY2FwdHVyZSA/IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpbmhlcml0XCJdIDogXCJpbmhlcml0XCIsXG4gIH0pO1xuICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2NvbW1hbmR9IGZhaWxlZDogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IHJlc3VsdC5zdGF0dXMpfWApO1xuICByZXR1cm4gY2FwdHVyZWRUZXh0KHJlc3VsdC5zdGRvdXQpO1xufVxuY29uc3QgY2xpID0gKC4uLmFyZ3M6IHN0cmluZ1tdKSA9PiBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCAuLi5hcmdzXSk7XG5jbGkoXCJwcm9qZWN0XCIsIFwiYWRkXCIsIHdvcmtzcGFjZSk7XG5jb25zdCB0b29sY2hhaW4gPSBwcm9jZXNzLmVudi5DSEVDS19UT09MQ0hBSU4gPyBbXCItLXRvb2xjaGFpblwiLCBwcm9jZXNzLmVudi5DSEVDS19UT09MQ0hBSU5dIDogW107XG5sZXQgZmFpbGVkID0gZmFsc2U7XG5jb25zdCBzdWNjZXNzZnVsID0gW107XG5mb3IgKGNvbnN0IFtpbmRleCwgcm9vdF0gb2Ygcm9vdHMuZW50cmllcygpKSB7XG4gIGNvbnNvbGUubG9nKGA6Omdyb3VwOjoke21vZGV9OiAke3Jvb3R9YCk7XG4gIHRyeSB7XG4gICAgaWYgKFtcIm5hdGl2ZVwiLCBcIm5hdGl2ZS1pbnN0YWxsXCIsIFwibmF0aXZlLWNoZWNrXCJdLmluY2x1ZGVzKG1vZGUpKSB7XG4gICAgICAvLyBNaXJpIGlzIGFuIGV4cGxpY2l0bHkgc2VsZWN0ZWQgbWFudWFsIGNoZWNrLCBub3QgcGFydCBvZiB0aGUgb3JkaW5hcnkgQ0kgc3RhZ2UuXG4gICAgICBpZiAobW9kZSAhPT0gXCJuYXRpdmUtY2hlY2tcIikgY2xpKFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1leGNsdWRlLXRvb2xcIiwgXCJtaXJpXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgICBpZiAobW9kZSAhPT0gXCJuYXRpdmUtaW5zdGFsbFwiKVxuICAgICAgICBjbGkoXCJjaGVja1wiLCBcIi0tc3RhZ2VcIiwgXCJjaVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09IFwiaW50ZWdyYXRpb25cIikge1xuICAgICAgY29uc3Qgc291cmNlID0gam9pbih3b3Jrc3BhY2UsIHJvb3QsIFwiYnVpbGRcIiwgXCJjb25zdW1lci1pbnRlZ3JhdGlvblwiKTtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHJlcG9ydFN0YXRlKHNvdXJjZSk7XG4gICAgICBjb25zdCBkZXN0aW5hdGlvbiA9IGpvaW4oXG4gICAgICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LlJVTk5FUl9URU1QLCBcIlJVTk5FUl9URU1QIGlzIHJlcXVpcmVkXCIpLFxuICAgICAgICBcImNvbnN1bWVyLWludGVncmF0aW9uXCIsXG4gICAgICAgIFN0cmluZyhpbmRleCksXG4gICAgICApO1xuICAgICAgbGV0IGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgXCJpbnRlZ3JhdGlvblwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgXCItLW5vLWNhY2hlXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmYWlsdXJlID0gZXJyb3JGcm9tKGVycm9yKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbGxlY3RSZXBvcnRzKHNvdXJjZSwgZGVzdGluYXRpb24sIGJlZm9yZSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZmFpbHVyZSAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihcbiAgICAgICAgICAgIFtmYWlsdXJlLCBlcnJvcl0sXG4gICAgICAgICAgICBgSW50ZWdyYXRpb24gY2hlY2sgYW5kIHJlcG9ydCBjb2xsZWN0aW9uIGZhaWxlZDogJHtlcnJvck1lc3NhZ2UoZmFpbHVyZSl9OyAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgICAgIHsgY2F1c2U6IGVycm9yIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBpZiAoZmFpbHVyZSAhPT0gdW5kZWZpbmVkKSB0aHJvdyBmYWlsdXJlO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIFwicmVsZWFzZVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIFwicmVsZWFzZS12ZXJpZnlcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgICBjb25zdCBhcnRpZmFjdHMgPSBqb2luKHJlcXVpcmVkKHByb2Nlc3MuZW52LlJVTk5FUl9URU1QLCBcIlJVTk5FUl9URU1QIGlzIHJlcXVpcmVkXCIpLCBcInJlbGVhc2UtYXJ0aWZhY3RzXCIpO1xuICAgICAgbWtkaXJTeW5jKGFydGlmYWN0cywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCB0YXIgPVxuICAgICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgICA/IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuU3lzdGVtUm9vdCwgXCJTeXN0ZW1Sb290IGlzIHJlcXVpcmVkXCIpLCBcIlN5c3RlbTMyXCIsIFwidGFyLmV4ZVwiKVxuICAgICAgICAgIDogXCJ0YXJcIjtcbiAgICAgIGNvbnN0IHBhdGhzID0gcmVjb3JkKFxuICAgICAgICBKU09OLnBhcnNlKFxuICAgICAgICAgIHJ1bihcbiAgICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwicGF0aHNcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbl0sXG4gICAgICAgICAgICB3b3Jrc3BhY2UsXG4gICAgICAgICAgICBwcm9jZXNzLmVudixcbiAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgICAgXCJJbnZhbGlkIHByb2plY3QgcGF0aHNcIixcbiAgICAgICk7XG4gICAgICBjb25zdCBkaXJlY3RvcnkgPSBzdHJpbmcoXG4gICAgICAgIHJlY29yZChwYXRocy52YXJpYWJsZXMsIFwiTWlzc2luZyBwYXRoIHZhcmlhYmxlc1wiKS5XT1JLQkVOQ0hfRElTVF9ESVIsXG4gICAgICAgIFwiTWlzc2luZyByZWxlYXNlIGRpcmVjdG9yeVwiLFxuICAgICAgKTtcbiAgICAgIHJ1bih0YXIsIFtcIi1jemZcIiwgam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LnRhci5nemApLCBcIi1DXCIsIGRpcmVjdG9yeSwgXCIuXCJdKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LnR4dGApLCBgJHtyb290fVxcbmApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJlbnZpcm9ubWVudFwiKSB7XG4gICAgICBjbGkoXG4gICAgICAgIFwiY2hlY2tcIixcbiAgICAgICAgXCItLXN0YWdlXCIsXG4gICAgICAgIFwiY2lcIixcbiAgICAgICAgXCItLXBhdGhcIixcbiAgICAgICAgcm9vdCxcbiAgICAgICAgXCItLWVudmlyb25tZW50XCIsXG4gICAgICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LkNIRUNLX0VOVklST05NRU5ULCBcIkNIRUNLX0VOVklST05NRU5UIGlzIHJlcXVpcmVkXCIpLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09IFwiY29tcGF0aWJpbGl0eVwiIHx8IG1vZGUgPT09IFwicHl0aG9uXCIpIHtcbiAgICAgIGNvbnN0IHJ1bnRpbWUgPSBtb2RlID09PSBcInB5dGhvblwiID8gXCJweXRob25cIiA6IHByb2Nlc3MuZW52LlJVTlRJTUU7XG4gICAgICBjb25zdCB2ZXJzaW9uID0gbW9kZSA9PT0gXCJweXRob25cIiA/IHByb2Nlc3MuZW52LlBZVEhPTl9WRVJTSU9OIDogcHJvY2Vzcy5lbnYuUlVOVElNRV9WRVJTSU9OO1xuICAgICAgaWYgKCFydW50aW1lIHx8ICFbXCJub2RlXCIsIFwicHl0aG9uXCIsIFwiZ29cIiwgXCJydXN0XCIsIFwiamF2YVwiLCBcInJ1YnlcIiwgXCJwaHBcIl0uaW5jbHVkZXMocnVudGltZSkgfHwgIXZlcnNpb24pXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImNvbXBhdGliaWxpdHkgcmVxdWlyZXMgYSBydW50aW1lIGFuZCB2ZXJzaW9uXCIpO1xuICAgICAgcnVuKFxuICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwiY29tcGF0aWJpbGl0eS1leGVjXCIsIHJvb3QsIHJ1bnRpbWUsIHZlcnNpb24sIFwiLS1jaGVja3NcIl0sXG4gICAgICAgIHdvcmtzcGFjZSxcbiAgICAgICAgeyAuLi5wcm9jZXNzLmVudiwgQ0hFQ0tfUk9PVFM6IEpTT04uc3RyaW5naWZ5KFtyb290XSkgfSxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImNvbXBpbGVyXCIgfHwgbW9kZSA9PT0gXCJjb21waWxlci1pbnN0YWxsXCIpIHtcbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IFtcbiAgICAgICAgXCItLWNvbXBpbGVyXCIsXG4gICAgICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LkNPTVBJTEVSLCBcIkNPTVBJTEVSIGlzIHJlcXVpcmVkXCIpLFxuICAgICAgICBcIi0tY29tcGlsZXItdmVyc2lvblwiLFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5DT01QSUxFUl9WRVJTSU9OLCBcIkNPTVBJTEVSX1ZFUlNJT04gaXMgcmVxdWlyZWRcIiksXG4gICAgICBdO1xuICAgICAgaWYgKG1vZGUgPT09IFwiY29tcGlsZXItaW5zdGFsbFwiKSBjbGkoXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXBhdGhcIiwgcm9vdCwgLi4uc2VsZWN0aW9uKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCByb2xlczogdW5rbm93biA9IEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuQ0hFQ0tfUk9MRVMgPz8gXCJbXVwiKTtcbiAgICAgICAgaWYgKCFpc1N0cmluZ0FycmF5KHJvbGVzKSB8fCAhcm9sZXMubGVuZ3RoIHx8IHJvbGVzLnNvbWUoKHJvbGUpID0+ICFjb21waWxlckNvbXBhdGliaWxpdHlSb2xlcy5pbmNsdWRlcyhyb2xlKSkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ0hFQ0tfUk9MRVMgbXVzdCBsaXN0IGNvbXBpbGVyIGNvbXBhdGliaWxpdHkgcm9sZXNcIik7XG4gICAgICAgIGZvciAoY29uc3Qgcm9sZSBvZiByb2xlcykgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgcm9sZSwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnNlbGVjdGlvbik7XG4gICAgICB9XG4gICAgfSBlbHNlIHRocm93IG5ldyBFcnJvcihgdW5rbm93biBDSSBtb2RlOiAke21vZGV9YCk7XG4gICAgc3VjY2Vzc2Z1bC5wdXNoKHJvb3QpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGZhaWxlZCA9IHRydWU7XG4gICAgY29uc29sZS5lcnJvcihgOjplcnJvcjo6JHtyb290fTogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWApO1xuICB9IGZpbmFsbHkge1xuICAgIGNvbnNvbGUubG9nKFwiOjplbmRncm91cDo6XCIpO1xuICB9XG59XG5pZiAoW1wibmF0aXZlXCIsIFwibmF0aXZlLWluc3RhbGxcIiwgXCJuYXRpdmUtY2hlY2tcIiwgXCJyZWxlYXNlXCJdLmluY2x1ZGVzKG1vZGUpICYmIHByb2Nlc3MuZW52LkdJVEhVQl9PVVRQVVQpXG4gIGFwcGVuZEZpbGVTeW5jKHByb2Nlc3MuZW52LkdJVEhVQl9PVVRQVVQsIGByb290cz0ke0pTT04uc3RyaW5naWZ5KHN1Y2Nlc3NmdWwpfVxcbmApO1xuaWYgKGZhaWxlZCkgcHJvY2Vzcy5leGl0Q29kZSA9IDE7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGVBQWUsVUFBVSxRQUFRLFFBQVEsY0FBYyxpQkFBaUI7QUFDakYsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxnQkFBZ0IsV0FBVyxxQkFBcUI7QUFDekQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtDQUFrQztBQUMzQyxTQUFTLGdCQUFnQixtQkFBbUI7QUFFNUMsTUFBTSxRQUFpQixLQUFLLE1BQU0sUUFBUSxJQUFJLGVBQWUsSUFBSTtBQUNqRSxJQUFJLENBQUMsY0FBYyxLQUFLLEtBQUssQ0FBQyxNQUFNLFVBQVUsTUFBTSxLQUFLLENBQUMsU0FBUyxPQUFPLFNBQVMsWUFBWSxDQUFDLElBQUk7QUFDbEcsUUFBTSxJQUFJLE1BQU0sd0NBQXdDO0FBQzFELE1BQU0sWUFBWSxRQUFRLElBQUk7QUFHOUIsSUFBSSxRQUFRLElBQUksdUJBQXVCLFFBQVEsSUFBSTtBQUNqRCxVQUFRLElBQUksdUJBQXVCO0FBQUEsSUFDakMsUUFBUSxJQUFJLDJCQUEyQixNQUFNLE9BQU8sSUFBSSxRQUFRLElBQUk7QUFBQSxJQUNwRTtBQUFBLEVBQ0Y7QUFDRixNQUFNLGVBQWUsUUFBUSxJQUFJLCtCQUErQjtBQUNoRSxNQUFNLE9BQU8sU0FBUyxRQUFRLEtBQUssQ0FBQyxHQUFHLGlCQUFpQjtBQUN4RCxTQUFTLElBQUksU0FBaUIsTUFBZ0IsTUFBTSxXQUFXLE1BQU0sUUFBUSxLQUFLLFVBQVUsT0FBTztBQUNqRyxRQUFNLFNBQVMsVUFBVSxTQUFTLE1BQU07QUFBQSxJQUN0QztBQUFBLElBQ0E7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLE9BQU8sVUFBVSxD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
