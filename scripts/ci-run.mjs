// Generated from ci-run.mts; edit the TypeScript source.
import { isStringArray, required, record, string, capturedText, errorFrom } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilerCompatibilityRoles } from "./ci-contract.mjs";
import { collectReports, reportState } from "./ci-reports.mjs";
const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!isStringArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
if (process.env.WORKBENCH_CI_TARGET && process.env.RUNNER_TEMP)
  process.env.WORKBENCH_STATE_HOME = join(process.env.RUNNER_TEMP, "workbench-state");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJ1bi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNTdHJpbmdBcnJheSwgcmVxdWlyZWQsIHJlY29yZCwgc3RyaW5nLCBjYXB0dXJlZFRleHQsIGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2NpLXJlc3VsdHMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBjb21waWxlckNvbXBhdGliaWxpdHlSb2xlcyB9IGZyb20gXCIuL2NpLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgY29sbGVjdFJlcG9ydHMsIHJlcG9ydFN0YXRlIH0gZnJvbSBcIi4vY2ktcmVwb3J0cy5tanNcIjtcblxuY29uc3Qgcm9vdHM6IHVua25vd24gPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkNIRUNLX1JPT1RTID8/IFwiW11cIik7XG5pZiAoIWlzU3RyaW5nQXJyYXkocm9vdHMpIHx8ICFyb290cy5sZW5ndGggfHwgcm9vdHMuc29tZSgocm9vdCkgPT4gdHlwZW9mIHJvb3QgIT09IFwic3RyaW5nXCIgfHwgIXJvb3QpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJDSEVDS19ST09UUyBtdXN0IGxpc3QgY29uZmlndXJlZCByb290c1wiKTtcbmNvbnN0IHdvcmtzcGFjZSA9IHByb2Nlc3MuY3dkKCk7XG4vLyBEaXNwb3NhYmxlIGxvY2FsIENJIHdvcmtlcnMga2VlcCB0aGVpciByZWdpc3RyYXRpb24gYmVzaWRlIHRoZWlyIHJldGFpbmVkIHJ1biBldmlkZW5jZS5cbmlmIChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfVEFSR0VUICYmIHByb2Nlc3MuZW52LlJVTk5FUl9URU1QKVxuICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfU1RBVEVfSE9NRSA9IGpvaW4ocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwid29ya2JlbmNoLXN0YXRlXCIpO1xuY29uc3QgZGlzdHJpYnV0aW9uID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UID8/IHdvcmtzcGFjZTtcbmNvbnN0IG1vZGUgPSByZXF1aXJlZChwcm9jZXNzLmFyZ3ZbMl0sIFwiTWlzc2luZyBDSSBtb2RlXCIpO1xuZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10sIGN3ZCA9IHdvcmtzcGFjZSwgZW52ID0gcHJvY2Vzcy5lbnYsIGNhcHR1cmUgPSBmYWxzZSkge1xuICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgIGN3ZCxcbiAgICBlbnYsXG4gICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgIHN0ZGlvOiBjYXB0dXJlID8gW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0gOiBcImluaGVyaXRcIixcbiAgfSk7XG4gIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyAhPT0gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gIHJldHVybiBjYXB0dXJlZFRleHQocmVzdWx0LnN0ZG91dCk7XG59XG5jb25zdCBjbGkgPSAoLi4uYXJnczogc3RyaW5nW10pID0+IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIC4uLmFyZ3NdKTtcbmNsaShcInByb2plY3RcIiwgXCJhZGRcIiwgd29ya3NwYWNlKTtcbmNvbnN0IHRvb2xjaGFpbiA9IHByb2Nlc3MuZW52LkNIRUNLX1RPT0xDSEFJTiA/IFtcIi0tdG9vbGNoYWluXCIsIHByb2Nlc3MuZW52LkNIRUNLX1RPT0xDSEFJTl0gOiBbXTtcbmxldCBmYWlsZWQgPSBmYWxzZTtcbmNvbnN0IHN1Y2Nlc3NmdWwgPSBbXTtcbmZvciAoY29uc3QgW2luZGV4LCByb290XSBvZiByb290cy5lbnRyaWVzKCkpIHtcbiAgY29uc29sZS5sb2coYDo6Z3JvdXA6OiR7bW9kZX06ICR7cm9vdH1gKTtcbiAgdHJ5IHtcbiAgICBpZiAoW1wibmF0aXZlXCIsIFwibmF0aXZlLWluc3RhbGxcIiwgXCJuYXRpdmUtY2hlY2tcIl0uaW5jbHVkZXMobW9kZSkpIHtcbiAgICAgIC8vIE1pcmkgaXMgYW4gZXhwbGljaXRseSBzZWxlY3RlZCBtYW51YWwgY2hlY2ssIG5vdCBwYXJ0IG9mIHRoZSBvcmRpbmFyeSBDSSBzdGFnZS5cbiAgICAgIGlmIChtb2RlICE9PSBcIm5hdGl2ZS1jaGVja1wiKSBjbGkoXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWV4Y2x1ZGUtdG9vbFwiLCBcIm1pcmlcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIGlmIChtb2RlICE9PSBcIm5hdGl2ZS1pbnN0YWxsXCIpXG4gICAgICAgIGNsaShcImNoZWNrXCIsIFwiLS1zdGFnZVwiLCBcImNpXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCAuLi50b29sY2hhaW4pO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJpbnRlZ3JhdGlvblwiKSB7XG4gICAgICBjb25zdCBzb3VyY2UgPSBqb2luKHdvcmtzcGFjZSwgcm9vdCwgXCJidWlsZFwiLCBcImNvbnN1bWVyLWludGVncmF0aW9uXCIpO1xuICAgICAgY29uc3QgYmVmb3JlID0gcmVwb3J0U3RhdGUoc291cmNlKTtcbiAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbihcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksXG4gICAgICAgIFwiY29uc3VtZXItaW50ZWdyYXRpb25cIixcbiAgICAgICAgU3RyaW5nKGluZGV4KSxcbiAgICAgICk7XG4gICAgICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgICB0cnkge1xuICAgICAgICBjbGkoXCJjaGVja1wiLCBcIi0tcm9sZVwiLCBcImludGVncmF0aW9uXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCBcIi0tbm8tY2FjaGVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGZhaWx1cmUgPSBlcnJvckZyb20oZXJyb3IpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29sbGVjdFJlcG9ydHMoc291cmNlLCBkZXN0aW5hdGlvbiwgYmVmb3JlKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChmYWlsdXJlICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKFxuICAgICAgICAgICAgW2ZhaWx1cmUsIGVycm9yXSxcbiAgICAgICAgICAgIGBJbnRlZ3JhdGlvbiBjaGVjayBhbmQgcmVwb3J0IGNvbGxlY3Rpb24gZmFpbGVkOiAke2Vycm9yTWVzc2FnZShmYWlsdXJlKX07ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gLFxuICAgICAgICAgICAgeyBjYXVzZTogZXJyb3IgfSxcbiAgICAgICAgICApO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIGlmIChmYWlsdXJlICE9PSB1bmRlZmluZWQpIHRocm93IGZhaWx1cmU7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgXCJyZWxlYXNlXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgXCJyZWxlYXNlLXZlcmlmeVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIGNvbnN0IGFydGlmYWN0cyA9IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksIFwicmVsZWFzZS1hcnRpZmFjdHNcIik7XG4gICAgICBta2RpclN5bmMoYXJ0aWZhY3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IHRhciA9XG4gICAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgID8gam9pbihyZXF1aXJlZChwcm9jZXNzLmVudi5TeXN0ZW1Sb290LCBcIlN5c3RlbVJvb3QgaXMgcmVxdWlyZWRcIiksIFwiU3lzdGVtMzJcIiwgXCJ0YXIuZXhlXCIpXG4gICAgICAgICAgOiBcInRhclwiO1xuICAgICAgY29uc3QgcGF0aHMgPSByZWNvcmQoXG4gICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgcnVuKFxuICAgICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJwYXRoc1wiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluXSxcbiAgICAgICAgICAgIHdvcmtzcGFjZSxcbiAgICAgICAgICAgIHByb2Nlc3MuZW52LFxuICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgICBcIkludmFsaWQgcHJvamVjdCBwYXRoc1wiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IHN0cmluZyhcbiAgICAgICAgcmVjb3JkKHBhdGhzLnZhcmlhYmxlcywgXCJNaXNzaW5nIHBhdGggdmFyaWFibGVzXCIpLldPUktCRU5DSF9ESVNUX0RJUixcbiAgICAgICAgXCJNaXNzaW5nIHJlbGVhc2UgZGlyZWN0b3J5XCIsXG4gICAgICApO1xuICAgICAgcnVuKHRhciwgW1wiLWN6ZlwiLCBqb2luKGFydGlmYWN0cywgYCR7U3RyaW5nKGluZGV4KX0udGFyLmd6YCksIFwiLUNcIiwgZGlyZWN0b3J5LCBcIi5cIl0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGFydGlmYWN0cywgYCR7U3RyaW5nKGluZGV4KX0udHh0YCksIGAke3Jvb3R9XFxuYCk7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImVudmlyb25tZW50XCIpIHtcbiAgICAgIGNsaShcbiAgICAgICAgXCJjaGVja1wiLFxuICAgICAgICBcIi0tc3RhZ2VcIixcbiAgICAgICAgXCJjaVwiLFxuICAgICAgICBcIi0tcGF0aFwiLFxuICAgICAgICByb290LFxuICAgICAgICBcIi0tZW52aXJvbm1lbnRcIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ0hFQ0tfRU5WSVJPTk1FTlQsIFwiQ0hFQ0tfRU5WSVJPTk1FTlQgaXMgcmVxdWlyZWRcIiksXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJjb21wYXRpYmlsaXR5XCIgfHwgbW9kZSA9PT0gXCJweXRob25cIikge1xuICAgICAgY29uc3QgcnVudGltZSA9IG1vZGUgPT09IFwicHl0aG9uXCIgPyBcInB5dGhvblwiIDogcHJvY2Vzcy5lbnYuUlVOVElNRTtcbiAgICAgIGNvbnN0IHZlcnNpb24gPSBtb2RlID09PSBcInB5dGhvblwiID8gcHJvY2Vzcy5lbnYuUFlUSE9OX1ZFUlNJT04gOiBwcm9jZXNzLmVudi5SVU5USU1FX1ZFUlNJT047XG4gICAgICBpZiAoIXJ1bnRpbWUgfHwgIVtcIm5vZGVcIiwgXCJweXRob25cIiwgXCJnb1wiLCBcInJ1c3RcIiwgXCJqYXZhXCIsIFwicnVieVwiLCBcInBocFwiXS5pbmNsdWRlcyhydW50aW1lKSB8fCAhdmVyc2lvbilcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY29tcGF0aWJpbGl0eSByZXF1aXJlcyBhIHJ1bnRpbWUgYW5kIHZlcnNpb25cIik7XG4gICAgICBydW4oXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJjb21wYXRpYmlsaXR5LWV4ZWNcIiwgcm9vdCwgcnVudGltZSwgdmVyc2lvbiwgXCItLWNoZWNrc1wiXSxcbiAgICAgICAgd29ya3NwYWNlLFxuICAgICAgICB7IC4uLnByb2Nlc3MuZW52LCBDSEVDS19ST09UUzogSlNPTi5zdHJpbmdpZnkoW3Jvb3RdKSB9LFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09IFwiY29tcGlsZXJcIiB8fCBtb2RlID09PSBcImNvbXBpbGVyLWluc3RhbGxcIikge1xuICAgICAgY29uc3Qgc2VsZWN0aW9uID0gW1xuICAgICAgICBcIi0tY29tcGlsZXJcIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ09NUElMRVIsIFwiQ09NUElMRVIgaXMgcmVxdWlyZWRcIiksXG4gICAgICAgIFwiLS1jb21waWxlci12ZXJzaW9uXCIsXG4gICAgICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LkNPTVBJTEVSX1ZFUlNJT04sIFwiQ09NUElMRVJfVkVSU0lPTiBpcyByZXF1aXJlZFwiKSxcbiAgICAgIF07XG4gICAgICBpZiAobW9kZSA9PT0gXCJjb21waWxlci1pbnN0YWxsXCIpIGNsaShcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCByb290LCAuLi5zZWxlY3Rpb24pO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNvbnN0IHJvbGVzOiB1bmtub3duID0gSlNPTi5wYXJzZShwcm9jZXNzLmVudi5DSEVDS19ST0xFUyA/PyBcIltdXCIpO1xuICAgICAgICBpZiAoIWlzU3RyaW5nQXJyYXkocm9sZXMpIHx8ICFyb2xlcy5sZW5ndGggfHwgcm9sZXMuc29tZSgocm9sZSkgPT4gIWNvbXBpbGVyQ29tcGF0aWJpbGl0eVJvbGVzLmluY2x1ZGVzKHJvbGUpKSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDSEVDS19ST0xFUyBtdXN0IGxpc3QgY29tcGlsZXIgY29tcGF0aWJpbGl0eSByb2xlc1wiKTtcbiAgICAgICAgZm9yIChjb25zdCByb2xlIG9mIHJvbGVzKSBjbGkoXCJjaGVja1wiLCBcIi0tcm9sZVwiLCByb2xlLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4uc2VsZWN0aW9uKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIENJIG1vZGU6ICR7bW9kZX1gKTtcbiAgICBzdWNjZXNzZnVsLnB1c2gocm9vdCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbGVkID0gdHJ1ZTtcbiAgICBjb25zb2xlLmVycm9yKGA6OmVycm9yOjoke3Jvb3R9OiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCk7XG4gIH0gZmluYWxseSB7XG4gICAgY29uc29sZS5sb2coXCI6OmVuZGdyb3VwOjpcIik7XG4gIH1cbn1cbmlmIChbXCJuYXRpdmVcIiwgXCJuYXRpdmUtaW5zdGFsbFwiLCBcIm5hdGl2ZS1jaGVja1wiLCBcInJlbGVhc2VcIl0uaW5jbHVkZXMobW9kZSkgJiYgcHJvY2Vzcy5lbnYuR0lUSFVCX09VVFBVVClcbiAgYXBwZW5kRmlsZVN5bmMocHJvY2Vzcy5lbnYuR0lUSFVCX09VVFBVVCwgYHJvb3RzPSR7SlNPTi5zdHJpbmdpZnkoc3VjY2Vzc2Z1bCl9XFxuYCk7XG5pZiAoZmFpbGVkKSBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsZUFBZSxVQUFVLFFBQVEsUUFBUSxjQUFjLGlC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
