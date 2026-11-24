// Generated from ci-run.mts; edit the TypeScript source.
import { isStringArray, required, record, string, capturedText, errorFrom } from "../app/src/core/runtime/values.mjs";
import { errorMessage } from "../app/src/core/execution/ci/support/ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { processCancellation } from "../app/src/core/runtime/owned-child.mjs";
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
      if (mode !== "native-check") {
        cli("tools", "install", "--path", root, "--exclude-tool", "miri", ...toolchain);
        if (process.env.WORKBENCH_PREPARED !== "1" && process.env.WORKBENCH_OFFLINE !== "1")
          cli("prepare", "--path", root, "--environment", "native", ...toolchain);
      }
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
      const candidate = root === "." ? process.env.WORKBENCH_CI_CANDIDATE : void 0;
      if (!candidate) cli("check", "--role", "release", "--path", root, "--environment", "native", ...toolchain);
      const artifacts = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "release-artifacts");
      mkdirSync(artifacts, { recursive: true });
      const pathVariables = () => record(
        record(
          JSON.parse(
            run(
              process.execPath,
              [
                join(distribution, "bin/workbench.mjs"),
                "paths",
                "--path",
                root,
                "--environment",
                "native",
                ...toolchain
              ],
              workspace,
              process.env,
              true
            )
          ),
          "Invalid project paths"
        ).variables,
        "Missing path variables"
      );
      const directory = candidate ? join(candidate, "workbench-artifacts") : string(pathVariables().WORKBENCH_DIST_DIR, "Missing release directory");
      const format = process.platform === "linux" ? "tar.gz" : "zip";
      const { verifyPackedRelease } = createRequire(import.meta.url)(
        "../bundle/package.cjs"
      );
      const cancellation = processCancellation();
      try {
        await verifyPackedRelease(
          directory,
          join(artifacts, `${String(index)}.${format}`),
          format,
          cancellation.signal,
          (extracted) => {
            run(
              process.execPath,
              [
                join(distribution, "bin/workbench.mjs"),
                "check",
                "--role",
                "release-verify",
                "--path",
                root,
                "--environment",
                "native",
                ...toolchain
              ],
              workspace,
              { ...process.env, WORKBENCH_CI_CANDIDATE: void 0, WORKBENCH_RELEASE_ARTIFACT: extracted }
            );
          }
        );
      } finally {
        cancellation.close();
      }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJ1bi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNTdHJpbmdBcnJheSwgcmVxdWlyZWQsIHJlY29yZCwgc3RyaW5nLCBjYXB0dXJlZFRleHQsIGVycm9yRnJvbSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBlcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaS9zdXBwb3J0L2NpLXJlc3VsdHMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuaW1wb3J0IHsgcHJvY2Vzc0NhbmNlbGxhdGlvbiB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS9vd25lZC1jaGlsZC5tanNcIjtcbmltcG9ydCB7IGNvbXBpbGVyQ29tcGF0aWJpbGl0eVJvbGVzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vY2kvc3VwcG9ydC9jaS1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IGNvbGxlY3RSZXBvcnRzLCByZXBvcnRTdGF0ZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NpL3N1cHBvcnQvY2ktcmVwb3J0cy5tanNcIjtcblxuY29uc3Qgcm9vdHM6IHVua25vd24gPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkNIRUNLX1JPT1RTID8/IFwiW11cIik7XG5pZiAoIWlzU3RyaW5nQXJyYXkocm9vdHMpIHx8ICFyb290cy5sZW5ndGggfHwgcm9vdHMuc29tZSgocm9vdCkgPT4gdHlwZW9mIHJvb3QgIT09IFwic3RyaW5nXCIgfHwgIXJvb3QpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJDSEVDS19ST09UUyBtdXN0IGxpc3QgY29uZmlndXJlZCByb290c1wiKTtcbmNvbnN0IHdvcmtzcGFjZSA9IHByb2Nlc3MuY3dkKCk7XG4vLyBSZWdpc3RyYXRpb24gc3RheXMgcHJpdmF0ZS4gQ29udGFpbmVyIHN0YXRlIGJlbG9uZ3MgdG8gaXRzIGRpc3Bvc2FibGUgZmlsZXN5c3RlbSxcbi8vIHNvIGEgdGVybWluYXRlZCBndWVzdCBjYW5ub3QgbGVhdmUgdW5yZWFkYWJsZSBwcml2YXRlIGRpcmVjdG9yaWVzIGluIHVwbG9hZGVkIHJlcG9ydHMuXG5pZiAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX1RBUkdFVCAmJiBwcm9jZXNzLmVudi5SVU5ORVJfVEVNUClcbiAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NUQVRFX0hPTUUgPSBqb2luKFxuICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9ERVZDT05UQUlORVIgPT09IFwiMVwiID8gdG1wZGlyKCkgOiBwcm9jZXNzLmVudi5SVU5ORVJfVEVNUCxcbiAgICBcIndvcmtiZW5jaC1zdGF0ZVwiLFxuICApO1xuY29uc3QgZGlzdHJpYnV0aW9uID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UID8/IHdvcmtzcGFjZTtcbmNvbnN0IG1vZGUgPSByZXF1aXJlZChwcm9jZXNzLmFyZ3ZbMl0sIFwiTWlzc2luZyBDSSBtb2RlXCIpO1xuZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10sIGN3ZCA9IHdvcmtzcGFjZSwgZW52ID0gcHJvY2Vzcy5lbnYsIGNhcHR1cmUgPSBmYWxzZSkge1xuICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgIGN3ZCxcbiAgICBlbnYsXG4gICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgIHN0ZGlvOiBjYXB0dXJlID8gW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0gOiBcImluaGVyaXRcIixcbiAgfSk7XG4gIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyAhPT0gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gIHJldHVybiBjYXB0dXJlZFRleHQocmVzdWx0LnN0ZG91dCk7XG59XG5jb25zdCBjbGkgPSAoLi4uYXJnczogc3RyaW5nW10pID0+IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIC4uLmFyZ3NdKTtcbmNsaShcInByb2plY3RcIiwgXCJhZGRcIiwgd29ya3NwYWNlKTtcbmNvbnN0IHRvb2xjaGFpbiA9IHByb2Nlc3MuZW52LkNIRUNLX1RPT0xDSEFJTiA/IFtcIi0tdG9vbGNoYWluXCIsIHByb2Nlc3MuZW52LkNIRUNLX1RPT0xDSEFJTl0gOiBbXTtcbmxldCBmYWlsZWQgPSBmYWxzZTtcbmNvbnN0IHN1Y2Nlc3NmdWwgPSBbXTtcbmZvciAoY29uc3QgW2luZGV4LCByb290XSBvZiByb290cy5lbnRyaWVzKCkpIHtcbiAgY29uc29sZS5sb2coYDo6Z3JvdXA6OiR7bW9kZX06ICR7cm9vdH1gKTtcbiAgdHJ5IHtcbiAgICBpZiAoW1wibmF0aXZlXCIsIFwibmF0aXZlLWluc3RhbGxcIiwgXCJuYXRpdmUtY2hlY2tcIl0uaW5jbHVkZXMobW9kZSkpIHtcbiAgICAgIC8vIE1pcmkgaXMgYW4gZXhwbGljaXRseSBzZWxlY3RlZCBtYW51YWwgY2hlY2ssIG5vdCBwYXJ0IG9mIHRoZSBvcmRpbmFyeSBDSSBzdGFnZS5cbiAgICAgIGlmIChtb2RlICE9PSBcIm5hdGl2ZS1jaGVja1wiKSB7XG4gICAgICAgIGNsaShcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgICBpZiAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkVEICE9PSBcIjFcIiAmJiBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfT0ZGTElORSAhPT0gXCIxXCIpXG4gICAgICAgICAgY2xpKFwicHJlcGFyZVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIH1cbiAgICAgIGlmIChtb2RlICE9PSBcIm5hdGl2ZS1pbnN0YWxsXCIpXG4gICAgICAgIGNsaShcImNpLWNoZWNrc1wiLCByb290LCBcIi0tbmV0d29ya1wiLCBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfQ0hFQ0tfTkVUV09SSyA/PyBcImFsbFwiLCAuLi50b29sY2hhaW4pO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJpbnRlZ3JhdGlvblwiKSB7XG4gICAgICBjb25zdCBzb3VyY2UgPSBqb2luKHdvcmtzcGFjZSwgcm9vdCwgXCJidWlsZFwiLCBcImNvbnN1bWVyLWludGVncmF0aW9uXCIpO1xuICAgICAgY29uc3QgYmVmb3JlID0gcmVwb3J0U3RhdGUoc291cmNlKTtcbiAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbihcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksXG4gICAgICAgIFwiY29uc3VtZXItaW50ZWdyYXRpb25cIixcbiAgICAgICAgU3RyaW5nKGluZGV4KSxcbiAgICAgICk7XG4gICAgICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgICB0cnkge1xuICAgICAgICBjbGkoXCJjaGVja1wiLCBcIi0tcm9sZVwiLCBcImludGVncmF0aW9uXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCBcIi0tbm8tY2FjaGVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGZhaWx1cmUgPSBlcnJvckZyb20oZXJyb3IpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29sbGVjdFJlcG9ydHMoc291cmNlLCBkZXN0aW5hdGlvbiwgYmVmb3JlKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChmYWlsdXJlICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKFxuICAgICAgICAgICAgW2ZhaWx1cmUsIGVycm9yXSxcbiAgICAgICAgICAgIGBJbnRlZ3JhdGlvbiBjaGVjayBhbmQgcmVwb3J0IGNvbGxlY3Rpb24gZmFpbGVkOiAke2Vycm9yTWVzc2FnZShmYWlsdXJlKX07ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gLFxuICAgICAgICAgICAgeyBjYXVzZTogZXJyb3IgfSxcbiAgICAgICAgICApO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIGlmIChmYWlsdXJlICE9PSB1bmRlZmluZWQpIHRocm93IGZhaWx1cmU7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgLy8gVGhlIHJvb3QgcG9ydGFibGUgcGFja2FnZSB3YXMgYnVpbHQgb25jZSBieSB0aGUgY2FuZGlkYXRlIHByb2R1Y2VyLiBFeGFtcGxlIHJlbGVhc2VzIHJlbWFpbiBkaXN0aW5jdC5cbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHJvb3QgPT09IFwiLlwiID8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0NBTkRJREFURSA6IHVuZGVmaW5lZDtcbiAgICAgIGlmICghY2FuZGlkYXRlKSBjbGkoXCJjaGVja1wiLCBcIi0tcm9sZVwiLCBcInJlbGVhc2VcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgICBjb25zdCBhcnRpZmFjdHMgPSBqb2luKHJlcXVpcmVkKHByb2Nlc3MuZW52LlJVTk5FUl9URU1QLCBcIlJVTk5FUl9URU1QIGlzIHJlcXVpcmVkXCIpLCBcInJlbGVhc2UtYXJ0aWZhY3RzXCIpO1xuICAgICAgbWtkaXJTeW5jKGFydGlmYWN0cywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBwYXRoVmFyaWFibGVzID0gKCkgPT5cbiAgICAgICAgcmVjb3JkKFxuICAgICAgICAgIHJlY29yZChcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHJ1bihcbiAgICAgICAgICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICAgICAgICAgICAgXCJwYXRoc1wiLFxuICAgICAgICAgICAgICAgICAgXCItLXBhdGhcIixcbiAgICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgICBcIi0tZW52aXJvbm1lbnRcIixcbiAgICAgICAgICAgICAgICAgIFwibmF0aXZlXCIsXG4gICAgICAgICAgICAgICAgICAuLi50b29sY2hhaW4sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB3b3Jrc3BhY2UsXG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5lbnYsXG4gICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBcIkludmFsaWQgcHJvamVjdCBwYXRoc1wiLFxuICAgICAgICAgICkudmFyaWFibGVzLFxuICAgICAgICAgIFwiTWlzc2luZyBwYXRoIHZhcmlhYmxlc1wiLFxuICAgICAgICApO1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gY2FuZGlkYXRlXG4gICAgICAgID8gam9pbihjYW5kaWRhdGUsIFwid29ya2JlbmNoLWFydGlmYWN0c1wiKVxuICAgICAgICA6IHN0cmluZyhwYXRoVmFyaWFibGVzKCkuV09SS0JFTkNIX0RJU1RfRElSLCBcIk1pc3NpbmcgcmVsZWFzZSBkaXJlY3RvcnlcIik7XG4gICAgICBjb25zdCBmb3JtYXQgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBcInRhci5nelwiIDogXCJ6aXBcIjtcbiAgICAgIGNvbnN0IHsgdmVyaWZ5UGFja2VkUmVsZWFzZSB9ID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpKFxuICAgICAgICBcIi4uL2J1bmRsZS9wYWNrYWdlLmNqc1wiLFxuICAgICAgKSBhcyB0eXBlb2YgaW1wb3J0KFwiLi4vYXBwL3NyYy9jb3JlL2FydGlmYWN0cy9wYWNrYWdlLmpzXCIpO1xuICAgICAgY29uc3QgY2FuY2VsbGF0aW9uID0gcHJvY2Vzc0NhbmNlbGxhdGlvbigpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdmVyaWZ5UGFja2VkUmVsZWFzZShcbiAgICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgICAgam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LiR7Zm9ybWF0fWApLFxuICAgICAgICAgIGZvcm1hdCxcbiAgICAgICAgICBjYW5jZWxsYXRpb24uc2lnbmFsLFxuICAgICAgICAgIChleHRyYWN0ZWQpID0+IHtcbiAgICAgICAgICAgIHJ1bihcbiAgICAgICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICAgICAgICAgIFwiY2hlY2tcIixcbiAgICAgICAgICAgICAgICBcIi0tcm9sZVwiLFxuICAgICAgICAgICAgICAgIFwicmVsZWFzZS12ZXJpZnlcIixcbiAgICAgICAgICAgICAgICBcIi0tcGF0aFwiLFxuICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgXCItLWVudmlyb25tZW50XCIsXG4gICAgICAgICAgICAgICAgXCJuYXRpdmVcIixcbiAgICAgICAgICAgICAgICAuLi50b29sY2hhaW4sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHdvcmtzcGFjZSxcbiAgICAgICAgICAgICAgeyAuLi5wcm9jZXNzLmVudiwgV09SS0JFTkNIX0NJX0NBTkRJREFURTogdW5kZWZpbmVkLCBXT1JLQkVOQ0hfUkVMRUFTRV9BUlRJRkFDVDogZXh0cmFjdGVkIH0sXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBjYW5jZWxsYXRpb24uY2xvc2UoKTtcbiAgICAgIH1cbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihhcnRpZmFjdHMsIGAke1N0cmluZyhpbmRleCl9LnR4dGApLCBgJHtyb290fVxcbmApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJlbnZpcm9ubWVudFwiKSB7XG4gICAgICBjbGkoXG4gICAgICAgIFwiY2ktY2hlY2tzXCIsXG4gICAgICAgIHJvb3QsXG4gICAgICAgIFwiLS1lbnZpcm9ubWVudFwiLFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5DSEVDS19FTlZJUk9OTUVOVCwgXCJDSEVDS19FTlZJUk9OTUVOVCBpcyByZXF1aXJlZFwiKSxcbiAgICAgICAgXCItLW5ldHdvcmtcIixcbiAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0NIRUNLX05FVFdPUksgPz8gXCJhbGxcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImNvbXBhdGliaWxpdHlcIiB8fCBtb2RlID09PSBcInB5dGhvblwiKSB7XG4gICAgICBjb25zdCBydW50aW1lID0gbW9kZSA9PT0gXCJweXRob25cIiA/IFwicHl0aG9uXCIgOiBwcm9jZXNzLmVudi5SVU5USU1FO1xuICAgICAgY29uc3QgdmVyc2lvbiA9IG1vZGUgPT09IFwicHl0aG9uXCIgPyBwcm9jZXNzLmVudi5QWVRIT05fVkVSU0lPTiA6IHByb2Nlc3MuZW52LlJVTlRJTUVfVkVSU0lPTjtcbiAgICAgIGlmICghcnVudGltZSB8fCAhW1wibm9kZVwiLCBcInB5dGhvblwiLCBcImdvXCIsIFwicnVzdFwiLCBcImphdmFcIiwgXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKHJ1bnRpbWUpIHx8ICF2ZXJzaW9uKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb21wYXRpYmlsaXR5IHJlcXVpcmVzIGEgcnVudGltZSBhbmQgdmVyc2lvblwiKTtcbiAgICAgIHJ1bihcbiAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcImNvbXBhdGliaWxpdHktZXhlY1wiLCByb290LCBydW50aW1lLCB2ZXJzaW9uLCBcIi0tY2hlY2tzXCJdLFxuICAgICAgICB3b3Jrc3BhY2UsXG4gICAgICAgIHsgLi4ucHJvY2Vzcy5lbnYsIENIRUNLX1JPT1RTOiBKU09OLnN0cmluZ2lmeShbcm9vdF0pIH0sXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJjb21waWxlclwiIHx8IG1vZGUgPT09IFwiY29tcGlsZXItaW5zdGFsbFwiKSB7XG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBbXG4gICAgICAgIFwiLS1jb21waWxlclwiLFxuICAgICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5DT01QSUxFUiwgXCJDT01QSUxFUiBpcyByZXF1aXJlZFwiKSxcbiAgICAgICAgXCItLWNvbXBpbGVyLXZlcnNpb25cIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ09NUElMRVJfVkVSU0lPTiwgXCJDT01QSUxFUl9WRVJTSU9OIGlzIHJlcXVpcmVkXCIpLFxuICAgICAgXTtcbiAgICAgIGlmIChtb2RlID09PSBcImNvbXBpbGVyLWluc3RhbGxcIikgY2xpKFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS1wYXRoXCIsIHJvb3QsIC4uLnNlbGVjdGlvbik7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3Qgcm9sZXM6IHVua25vd24gPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkNIRUNLX1JPTEVTID8/IFwiW11cIik7XG4gICAgICAgIGlmICghaXNTdHJpbmdBcnJheShyb2xlcykgfHwgIXJvbGVzLmxlbmd0aCB8fCByb2xlcy5zb21lKChyb2xlKSA9PiAhY29tcGlsZXJDb21wYXRpYmlsaXR5Um9sZXMuaW5jbHVkZXMocm9sZSkpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkNIRUNLX1JPTEVTIG11c3QgbGlzdCBjb21waWxlciBjb21wYXRpYmlsaXR5IHJvbGVzXCIpO1xuICAgICAgICBmb3IgKGNvbnN0IHJvbGUgb2Ygcm9sZXMpIGNsaShcImNoZWNrXCIsIFwiLS1yb2xlXCIsIHJvbGUsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCAuLi5zZWxlY3Rpb24pO1xuICAgICAgfVxuICAgIH0gZWxzZSB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gQ0kgbW9kZTogJHttb2RlfWApO1xuICAgIHN1Y2Nlc3NmdWwucHVzaChyb290KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsZWQgPSB0cnVlO1xuICAgIGNvbnNvbGUuZXJyb3IoYDo6ZXJyb3I6OiR7cm9vdH06ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjb25zb2xlLmxvZyhcIjo6ZW5kZ3JvdXA6OlwiKTtcbiAgfVxufVxuaWYgKFtcIm5hdGl2ZVwiLCBcIm5hdGl2ZS1pbnN0YWxsXCIsIFwibmF0aXZlLWNoZWNrXCIsIFwicmVsZWFzZVwiXS5pbmNsdWRlcyhtb2RlKSAmJiBwcm9jZXNzLmVudi5HSVRIVUJfT1VUUFVUKVxuICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfT1VUUFVULCBgcm9vdHM9JHtKU09OLnN0cmluZ2lmeShzdWNjZXNzZnVsKX1cXG5gKTtcbmlmIChmYWlsZWQpIHByb2Nlc3MuZXhpdENvZGUgPSAxO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxlQUFlLFVBQVUsUUFBUSxRQUFRLGNBQWMsaUJBQWlCO0FBQ2pGLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsZ0JBQWdCLFdBQVcscUJBQXFCO0FBQ3pELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxrQ0FBa0M7QUFDM0MsU0FBUyxnQkFBZ0IsbUJBQW1CO0FBRTVDLE1BQU0sUUFBaUIsS0FBSyxNQUFNLFFBQVEsSUFBSSxlQUFlLElBQUk7QUFDakUsSUFBSSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUMsTUFBTSxVQUFVLE1BQU0sS0FBSyxDQUFDLFNBQVMsT0FBTyxTQUFTLFlBQVksQ0FBQyxJQUFJO0FBQ2xHLFFBQU0sSUFBSSxNQUFNLHdDQUF3QztBQUMxRCxNQUFNLFlBQVksUUFBUSxJQUFJO0FBRzlCLElBQUksUUFBUSxJQUFJLHVCQUF1QixRQUFRLElBQUk7QUFDakQsVUFBUSxJQUFJLHVCQUF1QjtBQUFBLElBQ2pDLFFBQVEsSUFBSSwyQkFBMkIsTUFBTSxPQUFPLElBQUksUUFBUSxJQUFJO0FBQUEsSUFDcEU7QUFBQSxFQUNGO0FBQ0YsTUFBTSxlQUFlLFFBQVEsSUFBSSwrQkFBK0I7QUFDaEUsTUFBTSxPQUFPLFNBQVMsUUFBUSxLQUFLLENBQUMsR0FBRyxpQkFBaUI7QUFDeEQsU0FBUyxJQUFJLFNBQWlCLE1BQWdCLE1BQU0sV0FBVyxNQUFNLFFBQVEsS0FBSyxVQUFVLE9BQU87QUFDakcsUUFBTSxTQUFTLFVBQVUsU0FBUyxNQUFNO0FBQUEsSUFDdEM7QUFBQSxJQUNBO0FBQUEsSUFDQSxVQUFVO0FBQUEsSUFDVixPQUFPLFVBQVUsQ0FBQyxV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O0FBQUEsUUFDQSxRQUFRLElBQUksOEJBQThCO0FBQUEsTUFDNUM7QUFBQSxJQUNGLFdBQVcsU0FBUyxtQkFBbUIsU0FBUyxVQUFVO0FBQ3hELFlBQU0sVUFBVSxTQUFTLFdBQVcsV0FBVyxRQUFRLElBQUk7QUFDM0QsWUFBTSxVQUFVLFNBQVMsV0FBVyxRQUFRLElBQUksaUJBQWlCLFFBQVEsSUFBSTtBQUM3RSxVQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsUUFBUSxVQUFVLE1BQU0sUUFBUSxRQUFRLFFBQVEsS0FBSyxFQUFFLFNBQVMsT0FBTyxLQUFLLENBQUM7QUFDN0YsY0FBTSxJQUFJLE1BQU0sOENBQThDO0FBQ2hFO0FBQUEsUUFDRSxRQUFRO0FBQUEsUUFDUixDQUFDLEtBQUssY0FBYyxtQkFBbUIsR0FBRyxzQkFBc0IsTUFBTSxTQUFTLFNBQVMsVUFBVTtBQUFBLFFBQ2xHO0FBQUEsUUFDQSxFQUFFLEdBQUcsUUFBUSxLQUFLLGFBQWEsS0FBSyxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUU7QUFBQSxNQUN4RDtBQUFBLElBQ0YsV0FBVyxTQUFTLGNBQWMsU0FBUyxvQkFBb0I7QUFDN0QsWUFBTSxZQUFZO0FBQUEsUUFDaEI7QUFBQSxRQUNBLFNBQVMsUUFBUSxJQUFJLFVBQVUsc0JBQXNCO0FBQUEsUUFDckQ7QUFBQSxRQUNBLFNBQVMsUUFBUSxJQUFJLGtCQUFrQiw4QkFBOEI7QUFBQSxNQUN2RTtBQUNBLFVBQUksU0FBUyxtQkFBb0IsS0FBSSxTQUFTLFdBQVcsVUFBVSxNQUFNLEdBQUcsU0FBUztBQUFBLFdBQ2hGO0FBQ0gsY0FBTSxRQUFpQixLQUFLLE1BQU0sUUFBUSxJQUFJLGVBQWUsSUFBSTtBQUNqRSxZQUFJLENBQUMsY0FBYyxLQUFLLEtBQUssQ0FBQyxNQUFNLFVBQVUsTUFBTSxLQUFLLENBQUMsU0FBUyxDQUFDLDJCQUEyQixTQUFTLElBQUksQ0FBQztBQUMzRyxnQkFBTSxJQUFJLE1BQU0sb0RBQW9EO0FBQ3RFLG1CQUFXLFFBQVEsTUFBTyxLQUFJLFNBQVMsVUFBVSxNQUFNLFVBQVUsTUFBTSxpQkFBaUIsVUFBVSxHQUFHLFNBQVM7QUFBQSxNQUNoSDtBQUFBLElBQ0YsTUFBTyxPQUFNLElBQUksTUFBTSxvQkFBb0IsSUFBSSxFQUFFO0FBQ2pELGVBQVcsS0FBSyxJQUFJO0FBQUEsRUFDdEIsU0FBUyxPQUFPO0FBQ2QsYUFBUztBQUNULFlBQVEsTUFBTSxZQUFZLElBQUksS0FBSyxhQUFhLEtBQUssQ0FBQyxFQUFFO0FBQUEsRUFDMUQsVUFBRTtBQUNBLFlBQVEsSUFBSSxjQUFjO0FBQUEsRUFDNUI7QUFDRjtBQUNBLElBQUksQ0FBQyxVQUFVLGtCQUFrQixnQkFBZ0IsU0FBUyxFQUFFLFNBQVMsSUFBSSxLQUFLLFFBQVEsSUFBSTtBQUN4RixpQkFBZSxRQUFRLElBQUksZUFBZSxTQUFTLEtBQUssVUFBVSxVQUFVLENBQUM7QUFBQSxDQUFJO0FBQ25GLElBQUksT0FBUSxTQUFRLFdBQVc7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9jaS1ydW4ubWpzIn0=
