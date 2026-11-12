// Generated from ci-run.mts; edit the TypeScript source.
import { isStringArray, required, record, string, capturedText, errorFrom } from "../app/src/core/runtime/values.mjs";
import { errorMessage } from "../app/src/core/execution/ci/support/ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compilerCompatibilityRoles } from "../app/src/core/execution/ci/support/ci-contract.mjs";
import { collectReports, reportState } from "../app/src/core/execution/ci/support/ci-reports.mjs";
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
        cli("ci-checks", root, "--network", process.env.WORKBENCH_CI_CHECK_NETWORK ?? "all", ...toolchain);
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
      if (!(root === "." && process.env.WORKBENCH_CI_CANDIDATE))
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
      const directory = root === "." && process.env.WORKBENCH_CI_CANDIDATE ? join(process.env.WORKBENCH_CI_CANDIDATE, "workbench-artifacts") : string(record(paths.variables, "Missing path variables").WORKBENCH_DIST_DIR, "Missing release directory");
      run(tar, ["-czf", join(artifacts, `${String(index)}.tar.gz`), "-C", directory, "."]);
      writeFileSync(join(artifacts, `${String(index)}.txt`), `${root}
`);
    } else if (mode === "environment") {
      cli(
        "ci-checks",
        root,
        "--environment",
        required(process.env.CHECK_ENVIRONMENT, "CHECK_ENVIRONMENT is required"),
        "--network",
        process.env.WORKBENCH_CI_CHECK_NETWORK ?? "all"
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJ1bi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNTdHJpbmdBcnJheSwgcmVxdWlyZWQsIHJlY29yZCwgc3RyaW5nLCBjYXB0dXJlZFRleHQsIGVycm9yRnJvbSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBlcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaS9zdXBwb3J0L2NpLXJlc3VsdHMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgY29tcGlsZXJDb21wYXRpYmlsaXR5Um9sZXMgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaS9zdXBwb3J0L2NpLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgY29sbGVjdFJlcG9ydHMsIHJlcG9ydFN0YXRlIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vY2kvc3VwcG9ydC9jaS1yZXBvcnRzLm1qc1wiO1xuXG5jb25zdCByb290czogdW5rbm93biA9IEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuQ0hFQ0tfUk9PVFMgPz8gXCJbXVwiKTtcbmlmICghaXNTdHJpbmdBcnJheShyb290cykgfHwgIXJvb3RzLmxlbmd0aCB8fCByb290cy5zb21lKChyb290KSA9PiB0eXBlb2Ygcm9vdCAhPT0gXCJzdHJpbmdcIiB8fCAhcm9vdCkpXG4gIHRocm93IG5ldyBFcnJvcihcIkNIRUNLX1JPT1RTIG11c3QgbGlzdCBjb25maWd1cmVkIHJvb3RzXCIpO1xuY29uc3Qgd29ya3NwYWNlID0gcHJvY2Vzcy5jd2QoKTtcbi8vIFJlZ2lzdHJhdGlvbiBzdGF5cyBwcml2YXRlLiBDb250YWluZXIgc3RhdGUgYmVsb25ncyB0byBpdHMgZGlzcG9zYWJsZSBmaWxlc3lzdGVtLFxuLy8gc28gYSB0ZXJtaW5hdGVkIGd1ZXN0IGNhbm5vdCBsZWF2ZSB1bnJlYWRhYmxlIHByaXZhdGUgZGlyZWN0b3JpZXMgaW4gdXBsb2FkZWQgcmVwb3J0cy5cbmlmIChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfVEFSR0VUICYmIHByb2Nlc3MuZW52LlJVTk5FUl9URU1QKVxuICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfU1RBVEVfSE9NRSA9IGpvaW4oXG4gICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RFVkNPTlRBSU5FUiA9PT0gXCIxXCIgPyB0bXBkaXIoKSA6IHByb2Nlc3MuZW52LlJVTk5FUl9URU1QLFxuICAgIFwid29ya2JlbmNoLXN0YXRlXCIsXG4gICk7XG5jb25zdCBkaXN0cmlidXRpb24gPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1QgPz8gd29ya3NwYWNlO1xuY29uc3QgbW9kZSA9IHJlcXVpcmVkKHByb2Nlc3MuYXJndlsyXSwgXCJNaXNzaW5nIENJIG1vZGVcIik7XG5mdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgY3dkID0gd29ya3NwYWNlLCBlbnYgPSBwcm9jZXNzLmVudiwgY2FwdHVyZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhjb21tYW5kLCBhcmdzLCB7XG4gICAgY3dkLFxuICAgIGVudixcbiAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgc3RkaW86IGNhcHR1cmUgPyBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaW5oZXJpdFwiXSA6IFwiaW5oZXJpdFwiLFxuICB9KTtcbiAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzICE9PSAwKVxuICAgIHRocm93IG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKHJlc3VsdC5lcnJvciA/PyByZXN1bHQuc3RhdHVzKX1gKTtcbiAgcmV0dXJuIGNhcHR1cmVkVGV4dChyZXN1bHQuc3Rkb3V0KTtcbn1cbmNvbnN0IGNsaSA9ICguLi5hcmdzOiBzdHJpbmdbXSkgPT4gcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgLi4uYXJnc10pO1xuY2xpKFwicHJvamVjdFwiLCBcImFkZFwiLCB3b3Jrc3BhY2UpO1xuY29uc3QgdG9vbGNoYWluID0gcHJvY2Vzcy5lbnYuQ0hFQ0tfVE9PTENIQUlOID8gW1wiLS10b29sY2hhaW5cIiwgcHJvY2Vzcy5lbnYuQ0hFQ0tfVE9PTENIQUlOXSA6IFtdO1xubGV0IGZhaWxlZCA9IGZhbHNlO1xuY29uc3Qgc3VjY2Vzc2Z1bCA9IFtdO1xuZm9yIChjb25zdCBbaW5kZXgsIHJvb3RdIG9mIHJvb3RzLmVudHJpZXMoKSkge1xuICBjb25zb2xlLmxvZyhgOjpncm91cDo6JHttb2RlfTogJHtyb290fWApO1xuICB0cnkge1xuICAgIGlmIChbXCJuYXRpdmVcIiwgXCJuYXRpdmUtaW5zdGFsbFwiLCBcIm5hdGl2ZS1jaGVja1wiXS5pbmNsdWRlcyhtb2RlKSkge1xuICAgICAgLy8gTWlyaSBpcyBhbiBleHBsaWNpdGx5IHNlbGVjdGVkIG1hbnVhbCBjaGVjaywgbm90IHBhcnQgb2YgdGhlIG9yZGluYXJ5IENJIHN0YWdlLlxuICAgICAgaWYgKG1vZGUgIT09IFwibmF0aXZlLWNoZWNrXCIpIGNsaShcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgaWYgKG1vZGUgIT09IFwibmF0aXZlLWluc3RhbGxcIilcbiAgICAgICAgY2xpKFwiY2ktY2hlY2tzXCIsIHJvb3QsIFwiLS1uZXR3b3JrXCIsIHByb2Nlc3MuZW52LldPUktCRU5DSF9DSV9DSEVDS19ORVRXT1JLID8/IFwiYWxsXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImludGVncmF0aW9uXCIpIHtcbiAgICAgIGNvbnN0IHNvdXJjZSA9IGpvaW4od29ya3NwYWNlLCByb290LCBcImJ1aWxkXCIsIFwiY29uc3VtZXItaW50ZWdyYXRpb25cIik7XG4gICAgICBjb25zdCBiZWZvcmUgPSByZXBvcnRTdGF0ZShzb3VyY2UpO1xuICAgICAgY29uc3QgZGVzdGluYXRpb24gPSBqb2luKFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5SVU5ORVJfVEVNUCwgXCJSVU5ORVJfVEVNUCBpcyByZXF1aXJlZFwiKSxcbiAgICAgICAgXCJjb25zdW1lci1pbnRlZ3JhdGlvblwiLFxuICAgICAgICBTdHJpbmcoaW5kZXgpLFxuICAgICAgKTtcbiAgICAgIGxldCBmYWlsdXJlOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIFwiaW50ZWdyYXRpb25cIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIFwiLS1uby1jYWNoZVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmFpbHVyZSA9IGVycm9yRnJvbShlcnJvcik7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBjb2xsZWN0UmVwb3J0cyhzb3VyY2UsIGRlc3RpbmF0aW9uLCBiZWZvcmUpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKGZhaWx1cmUgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoXG4gICAgICAgICAgICBbZmFpbHVyZSwgZXJyb3JdLFxuICAgICAgICAgICAgYEludGVncmF0aW9uIGNoZWNrIGFuZCByZXBvcnQgY29sbGVjdGlvbiBmYWlsZWQ6ICR7ZXJyb3JNZXNzYWdlKGZhaWx1cmUpfTsgJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWAsXG4gICAgICAgICAgICB7IGNhdXNlOiBlcnJvciB9LFxuICAgICAgICAgICk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICAgaWYgKGZhaWx1cmUgIT09IHVuZGVmaW5lZCkgdGhyb3cgZmFpbHVyZTtcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAvLyBUaGUgcm9vdCBwb3J0YWJsZSBwYWNrYWdlIHdhcyBidWlsdCBvbmNlIGJ5IHRoZSBjYW5kaWRhdGUgcHJvZHVjZXIuIEV4YW1wbGUgcmVsZWFzZXMgcmVtYWluIGRpc3RpbmN0LlxuICAgICAgaWYgKCEocm9vdCA9PT0gXCIuXCIgJiYgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0NBTkRJREFURSkpXG4gICAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIFwicmVsZWFzZVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIFwicmVsZWFzZS12ZXJpZnlcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgICBjb25zdCBhcnRpZmFjdHMgPSBqb2luKHJlcXVpcmVkKHByb2Nlc3MuZW52LlJVTk5FUl9URU1QLCBcIlJVTk5FUl9URU1QIGlzIHJlcXVpcmVkXCIpLCBcInJlbGVhc2UtYXJ0aWZhY3RzXCIpO1xuICAgICAgbWtkaXJTeW5jKGFydGlmYWN0cywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCB0YXIgPVxuICAgICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgICA/IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuU3lzdGVtUm9vdCwgXCJTeXN0ZW1Sb290IGlzIHJlcXVpcmVkXCIpLCBcIlN5c3RlbTMyXCIsIFwidGFyLmV4ZVwiKVxuICAgICAgICAgIDogXCJ0YXJcIjtcbiAgICAgIGNvbnN0IHBhdGhzID0gcmVjb3JkKFxuICAgICAgICBKU09OLnBhcnNlKFxuICAgICAgICAgIHJ1bihcbiAgICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwicGF0aHNcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbl0sXG4gICAgICAgICAgICB3b3Jrc3BhY2UsXG4gICAgICAgICAgICBwcm9jZXNzLmVudixcbiAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgICAgXCJJbnZhbGlkIHByb2plY3QgcGF0aHNcIixcbiAgICAgICk7XG4gICAgICBjb25zdCBkaXJlY3RvcnkgPVxuICAgICAgICByb290ID09PSBcIi5cIiAmJiBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfQ0FORElEQVRFXG4gICAgICAgICAgPyBqb2luKHByb2Nlc3MuZW52LldPUktCRU5DSF9DSV9DQU5ESURBVEUsIFwid29ya2JlbmNoLWFydGlmYWN0c1wiKVxuICAgICAgICAgIDogc3RyaW5nKHJlY29yZChwYXRocy52YXJpYWJsZXMsIFwiTWlzc2luZyBwYXRoIHZhcmlhYmxlc1wiKS5XT1JLQkVOQ0hfRElTVF9ESVIsIFwiTWlzc2luZyByZWxlYXNlIGRpcmVjdG9yeVwiKTtcbiAgICAgIHJ1bih0YXIsIFtcIi1jemZcIiwgam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LnRhci5nemApLCBcIi1DXCIsIGRpcmVjdG9yeSwgXCIuXCJdKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LnR4dGApLCBgJHtyb290fVxcbmApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJlbnZpcm9ubWVudFwiKSB7XG4gICAgICBjbGkoXG4gICAgICAgIFwiY2ktY2hlY2tzXCIsXG4gICAgICAgIHJvb3QsXG4gICAgICAgIFwiLS1lbnZpcm9ubWVudFwiLFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5DSEVDS19FTlZJUk9OTUVOVCwgXCJDSEVDS19FTlZJUk9OTUVOVCBpcyByZXF1aXJlZFwiKSxcbiAgICAgICAgXCItLW5ldHdvcmtcIixcbiAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0NIRUNLX05FVFdPUksgPz8gXCJhbGxcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImNvbXBhdGliaWxpdHlcIiB8fCBtb2RlID09PSBcInB5dGhvblwiKSB7XG4gICAgICBjb25zdCBydW50aW1lID0gbW9kZSA9PT0gXCJweXRob25cIiA/IFwicHl0aG9uXCIgOiBwcm9jZXNzLmVudi5SVU5USU1FO1xuICAgICAgY29uc3QgdmVyc2lvbiA9IG1vZGUgPT09IFwicHl0aG9uXCIgPyBwcm9jZXNzLmVudi5QWVRIT05fVkVSU0lPTiA6IHByb2Nlc3MuZW52LlJVTlRJTUVfVkVSU0lPTjtcbiAgICAgIGlmICghcnVudGltZSB8fCAhW1wibm9kZVwiLCBcInB5dGhvblwiLCBcImdvXCIsIFwicnVzdFwiLCBcImphdmFcIiwgXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKHJ1bnRpbWUpIHx8ICF2ZXJzaW9uKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb21wYXRpYmlsaXR5IHJlcXVpcmVzIGEgcnVudGltZSBhbmQgdmVyc2lvblwiKTtcbiAgICAgIHJ1bihcbiAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcImNvbXBhdGliaWxpdHktZXhlY1wiLCByb290LCBydW50aW1lLCB2ZXJzaW9uLCBcIi0tY2hlY2tzXCJdLFxuICAgICAgICB3b3Jrc3BhY2UsXG4gICAgICAgIHsgLi4ucHJvY2Vzcy5lbnYsIENIRUNLX1JPT1RTOiBKU09OLnN0cmluZ2lmeShbcm9vdF0pIH0sXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJjb21waWxlclwiIHx8IG1vZGUgPT09IFwiY29tcGlsZXItaW5zdGFsbFwiKSB7XG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBbXG4gICAgICAgIFwiLS1jb21waWxlclwiLFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5DT01QSUxFUiwgXCJDT01QSUxFUiBpcyByZXF1aXJlZFwiKSxcbiAgICAgICAgXCItLWNvbXBpbGVyLXZlcnNpb25cIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ09NUElMRVJfVkVSU0lPTiwgXCJDT01QSUxFUl9WRVJTSU9OIGlzIHJlcXVpcmVkXCIpLFxuICAgICAgXTtcbiAgICAgIGlmIChtb2RlID09PSBcImNvbXBpbGVyLWluc3RhbGxcIikgY2xpKFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS1wYXRoXCIsIHJvb3QsIC4uLnNlbGVjdGlvbik7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3Qgcm9sZXM6IHVua25vd24gPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkNIRUNLX1JPTEVTID8/IFwiW11cIik7XG4gICAgICAgIGlmICghaXNTdHJpbmdBcnJheShyb2xlcykgfHwgIXJvbGVzLmxlbmd0aCB8fCByb2xlcy5zb21lKChyb2xlKSA9PiAhY29tcGlsZXJDb21wYXRpYmlsaXR5Um9sZXMuaW5jbHVkZXMocm9sZSkpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkNIRUNLX1JPTEVTIG11c3QgbGlzdCBjb21waWxlciBjb21wYXRpYmlsaXR5IHJvbGVzXCIpO1xuICAgICAgICBmb3IgKGNvbnN0IHJvbGUgb2Ygcm9sZXMpIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIHJvbGUsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCAuLi5zZWxlY3Rpb24pO1xuICAgICAgfVxuICAgIH0gZWxzZSB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gQ0kgbW9kZTogJHttb2RlfWApO1xuICAgIHN1Y2Nlc3NmdWwucHVzaChyb290KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsZWQgPSB0cnVlO1xuICAgIGNvbnNvbGUuZXJyb3IoYDo6ZXJyb3I6OiR7cm9vdH06ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjb25zb2xlLmxvZyhcIjo6ZW5kZ3JvdXA6OlwiKTtcbiAgfVxufVxuaWYgKFtcIm5hdGl2ZVwiLCBcIm5hdGl2ZS1pbnN0YWxsXCIsIFwibmF0aXZlLWNoZWNrXCIsIFwicmVsZWFzZVwiXS5pbmNsdWRlcyhtb2RlKSAmJiBwcm9jZXNzLmVudi5HSVRIVUJfT1VUUFVUKVxuICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfT1VUUFVULCBgcm9vdHM9JHtKU09OLnN0cmluZ2lmeShzdWNjZXNzZnVsKX1cXG5gKTtcbmlmIChmYWlsZWQpIHByb2Nlc3MuZXhpdENvZGUgPSAxO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxlQUFlLFVBQVUsUUFBUSxRQUFRLGNBQWMsaUJBQWlCO0FBQ2pGLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsZ0JBQWdCLFdBQVcscUJBQXFCO0FBQ3pELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQ0FBa0M7QUFDM0MsU0FBUyxnQkFBZ0IsbUJBQW1CO0FBRTVDLE1BQU0sUUFBaUIsS0FBSyxNQUFNLFFBQVEsSUFBSSxlQUFlLElBQUk7QUFDakUsSUFBSSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUMsTUFBTSxV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QkFBOEI7QUFBQSxNQUM1QztBQUFBLElBQ0YsV0FBVyxTQUFTLG1CQUFtQixTQUFTLFVBQVU7QUFDeEQsWUFBTSxVQUFVLFNBQVMsV0FBVyxXQUFXLFFBQVEsSUFBSTtBQUMzRCxZQUFNLFVBQVUsU0FBUyxXQUFXLFFBQVEsSUFBSSxpQkFBaUIsUUFBUSxJQUFJO0FBQzdFLFVBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxRQUFRLFVBQVUsTUFBTSxRQUFRLFFBQVEsUUFBUSxLQUFLLEVBQUUsU0FBUyxPQUFPLEtBQUssQ0FBQztBQUM3RixjQUFNLElBQUksTUFBTSw4Q0FBOEM7QUFDaEU7QUFBQSxRQUNFLFFBQVE7QUFBQSxRQUNSLENBQUMsS0FBSyxjQUFjLG1CQUFtQixHQUFHLHNCQUFzQixNQUFNLFNBQVMsU0FBUyxVQUFVO0FBQUEsUUFDbEc7QUFBQSxRQUNBLEVBQUUsR0FBRyxRQUFRLEtBQUssYUFBYSxLQUFLLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRTtBQUFBLE1BQ3hEO0FBQUEsSUFDRixXQUFXLFNBQVMsY0FBYyxTQUFTLG9CQUFvQjtBQUM3RCxZQUFNLFlBQVk7QUFBQSxRQUNoQjtBQUFBLFFBQ0EsU0FBUyxRQUFRLElBQUksVUFBVSxzQkFBc0I7QUFBQSxRQUNyRDtBQUFBLFFBQ0EsU0FBUyxRQUFRLElBQUksa0JBQWtCLDhCQUE4QjtBQUFBLE1BQ3ZFO0FBQ0EsVUFBSSxTQUFTLG1CQUFvQixLQUFJLFNBQVMsV0FBVyxVQUFVLE1BQU0sR0FBRyxTQUFTO0FBQUEsV0FDaEY7QUFDSCxjQUFNLFFBQWlCLEtBQUssTUFBTSxRQUFRLElBQUksZUFBZSxJQUFJO0FBQ2pFLFlBQUksQ0FBQyxjQUFjLEtBQUssS0FBSyxDQUFDLE1BQU0sVUFBVSxNQUFNLEtBQUssQ0FBQyxTQUFTLENBQUMsMkJBQTJCLFNBQVMsSUFBSSxDQUFDO0FBQzNHLGdCQUFNLElBQUksTUFBTSxvREFBb0Q7QUFDdEUsbUJBQVcsUUFBUSxNQUFPLEtBQUksU0FBUyxVQUFVLE1BQU0sVUFBVSxNQUFNLGlCQUFpQixVQUFVLEdBQUcsU0FBUztBQUFBLE1BQ2hIO0FBQUEsSUFDRixNQUFPLE9BQU0sSUFBSSxNQUFNLG9CQUFvQixJQUFJLEVBQUU7QUFDakQsZUFBVyxLQUFLLElBQUk7QUFBQSxFQUN0QixTQUFTLE9BQU87QUFDZCxhQUFTO0FBQ1QsWUFBUSxNQUFNLFlBQVksSUFBSSxLQUFLLGFBQWEsS0FBSyxDQUFDLEVBQUU7QUFBQSxFQUMxRCxVQUFFO0FBQ0EsWUFBUSxJQUFJLGNBQWM7QUFBQSxFQUM1QjtBQUNGO0FBQ0EsSUFBSSxDQUFDLFVBQVUsa0JBQWtCLGdCQUFnQixTQUFTLEVBQUUsU0FBUyxJQUFJLEtBQUssUUFBUSxJQUFJO0FBQ3hGLGlCQUFlLFFBQVEsSUFBSSxlQUFlLFNBQVMsS0FBSyxVQUFVLFVBQVUsQ0FBQztBQUFBLENBQUk7QUFDbkYsSUFBSSxPQUFRLFNBQVEsV0FBVzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL2NpLXJ1bi5tanMifQ==
