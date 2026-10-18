// Generated from ci-run.mts; edit the TypeScript source.
import { isStringArray, required, record, string, capturedText } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilerCompatibilityRoles } from "./ci-contract.mjs";
const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!isStringArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJ1bi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNTdHJpbmdBcnJheSwgcmVxdWlyZWQsIHJlY29yZCwgc3RyaW5nLCBjYXB0dXJlZFRleHQgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBlcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi9jaS1yZXN1bHRzLm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgYXBwZW5kRmlsZVN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tcGlsZXJDb21wYXRpYmlsaXR5Um9sZXMgfSBmcm9tIFwiLi9jaS1jb250cmFjdC5tanNcIjtcblxuY29uc3Qgcm9vdHM6IHVua25vd24gPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkNIRUNLX1JPT1RTID8/IFwiW11cIik7XG5pZiAoIWlzU3RyaW5nQXJyYXkocm9vdHMpIHx8ICFyb290cy5sZW5ndGggfHwgcm9vdHMuc29tZSgocm9vdCkgPT4gdHlwZW9mIHJvb3QgIT09IFwic3RyaW5nXCIgfHwgIXJvb3QpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJDSEVDS19ST09UUyBtdXN0IGxpc3QgY29uZmlndXJlZCByb290c1wiKTtcbmNvbnN0IHdvcmtzcGFjZSA9IHByb2Nlc3MuY3dkKCk7XG5jb25zdCBkaXN0cmlidXRpb24gPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1QgPz8gd29ya3NwYWNlO1xuY29uc3QgbW9kZSA9IHJlcXVpcmVkKHByb2Nlc3MuYXJndlsyXSwgXCJNaXNzaW5nIENJIG1vZGVcIik7XG5mdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgY3dkID0gd29ya3NwYWNlLCBlbnYgPSBwcm9jZXNzLmVudiwgY2FwdHVyZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhjb21tYW5kLCBhcmdzLCB7XG4gICAgY3dkLFxuICAgIGVudixcbiAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgc3RkaW86IGNhcHR1cmUgPyBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaW5oZXJpdFwiXSA6IFwiaW5oZXJpdFwiLFxuICB9KTtcbiAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzICE9PSAwKVxuICAgIHRocm93IG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKHJlc3VsdC5lcnJvciA/PyByZXN1bHQuc3RhdHVzKX1gKTtcbiAgcmV0dXJuIGNhcHR1cmVkVGV4dChyZXN1bHQuc3Rkb3V0KTtcbn1cbmNvbnN0IGNsaSA9ICguLi5hcmdzOiBzdHJpbmdbXSkgPT4gcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgLi4uYXJnc10pO1xuY29uc3QgdG9vbGNoYWluID0gcHJvY2Vzcy5lbnYuQ0hFQ0tfVE9PTENIQUlOID8gW1wiLS10b29sY2hhaW5cIiwgcHJvY2Vzcy5lbnYuQ0hFQ0tfVE9PTENIQUlOXSA6IFtdO1xubGV0IGZhaWxlZCA9IGZhbHNlO1xuY29uc3Qgc3VjY2Vzc2Z1bCA9IFtdO1xuZm9yIChjb25zdCBbaW5kZXgsIHJvb3RdIG9mIHJvb3RzLmVudHJpZXMoKSkge1xuICBjb25zb2xlLmxvZyhgOjpncm91cDo6JHttb2RlfTogJHtyb290fWApO1xuICB0cnkge1xuICAgIGlmIChbXCJuYXRpdmVcIiwgXCJuYXRpdmUtaW5zdGFsbFwiLCBcIm5hdGl2ZS1jaGVja1wiXS5pbmNsdWRlcyhtb2RlKSkge1xuICAgICAgLy8gTWlyaSBpcyBhbiBleHBsaWNpdGx5IHNlbGVjdGVkIG1hbnVhbCBjaGVjaywgbm90IHBhcnQgb2YgdGhlIG9yZGluYXJ5IENJIHN0YWdlLlxuICAgICAgaWYgKG1vZGUgIT09IFwibmF0aXZlLWNoZWNrXCIpIGNsaShcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgaWYgKG1vZGUgIT09IFwibmF0aXZlLWluc3RhbGxcIilcbiAgICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXN0YWdlXCIsIFwiY2lcIiwgXCItLXBhdGhcIiwgcm9vdCwgXCItLWVudmlyb25tZW50XCIsIFwibmF0aXZlXCIsIC4uLnRvb2xjaGFpbik7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgXCJyZWxlYXNlXCIsIFwiLS1wYXRoXCIsIHJvb3QsIFwiLS1lbnZpcm9ubWVudFwiLCBcIm5hdGl2ZVwiLCAuLi50b29sY2hhaW4pO1xuICAgICAgY2xpKFwiY2hlY2tcIiwgXCItLXJvbGVcIiwgXCJyZWxlYXNlLXZlcmlmeVwiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluKTtcbiAgICAgIGNvbnN0IGFydGlmYWN0cyA9IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksIFwicmVsZWFzZS1hcnRpZmFjdHNcIik7XG4gICAgICBta2RpclN5bmMoYXJ0aWZhY3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IHRhciA9XG4gICAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgID8gam9pbihyZXF1aXJlZChwcm9jZXNzLmVudi5TeXN0ZW1Sb290LCBcIlN5c3RlbVJvb3QgaXMgcmVxdWlyZWRcIiksIFwiU3lzdGVtMzJcIiwgXCJ0YXIuZXhlXCIpXG4gICAgICAgICAgOiBcInRhclwiO1xuICAgICAgY29uc3QgcGF0aHMgPSByZWNvcmQoXG4gICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgcnVuKFxuICAgICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJwYXRoc1wiLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4udG9vbGNoYWluXSxcbiAgICAgICAgICAgIHdvcmtzcGFjZSxcbiAgICAgICAgICAgIHByb2Nlc3MuZW52LFxuICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgICBcIkludmFsaWQgcHJvamVjdCBwYXRoc1wiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IHN0cmluZyhcbiAgICAgICAgcmVjb3JkKHBhdGhzLnZhcmlhYmxlcywgXCJNaXNzaW5nIHBhdGggdmFyaWFibGVzXCIpLldPUktCRU5DSF9ESVNUX0RJUixcbiAgICAgICAgXCJNaXNzaW5nIHJlbGVhc2UgZGlyZWN0b3J5XCIsXG4gICAgICApO1xuICAgICAgcnVuKHRhciwgW1wiLWN6ZlwiLCBqb2luKGFydGlmYWN0cywgYCR7U3RyaW5nKGluZGV4KX0udGFyLmd6YCksIFwiLUNcIiwgZGlyZWN0b3J5LCBcIi5cIl0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGFydGlmYWN0cywgYCR7U3RyaW5nKGluZGV4KX0udHh0YCksIGAke3Jvb3R9XFxuYCk7XG4gICAgfSBlbHNlIGlmIChtb2RlID09PSBcImVudmlyb25tZW50XCIpIHtcbiAgICAgIGNsaShcbiAgICAgICAgXCJjaGVja1wiLFxuICAgICAgICBcIi0tc3RhZ2VcIixcbiAgICAgICAgXCJjaVwiLFxuICAgICAgICBcIi0tcGF0aFwiLFxuICAgICAgICByb290LFxuICAgICAgICBcIi0tZW52aXJvbm1lbnRcIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ0hFQ0tfRU5WSVJPTk1FTlQsIFwiQ0hFQ0tfRU5WSVJPTk1FTlQgaXMgcmVxdWlyZWRcIiksXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gXCJjb21wYXRpYmlsaXR5XCIgfHwgbW9kZSA9PT0gXCJweXRob25cIikge1xuICAgICAgY29uc3QgcnVudGltZSA9IG1vZGUgPT09IFwicHl0aG9uXCIgPyBcInB5dGhvblwiIDogcHJvY2Vzcy5lbnYuUlVOVElNRTtcbiAgICAgIGNvbnN0IHZlcnNpb24gPSBtb2RlID09PSBcInB5dGhvblwiID8gcHJvY2Vzcy5lbnYuUFlUSE9OX1ZFUlNJT04gOiBwcm9jZXNzLmVudi5SVU5USU1FX1ZFUlNJT047XG4gICAgICBpZiAoIXJ1bnRpbWUgfHwgIVtcIm5vZGVcIiwgXCJweXRob25cIiwgXCJnb1wiLCBcInJ1c3RcIiwgXCJqYXZhXCIsIFwicnVieVwiLCBcInBocFwiXS5pbmNsdWRlcyhydW50aW1lKSB8fCAhdmVyc2lvbilcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY29tcGF0aWJpbGl0eSByZXF1aXJlcyBhIHJ1bnRpbWUgYW5kIHZlcnNpb25cIik7XG4gICAgICBydW4oXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJjb21wYXRpYmlsaXR5LWV4ZWNcIiwgcm9vdCwgcnVudGltZSwgdmVyc2lvbiwgXCItLWNoZWNrc1wiXSxcbiAgICAgICAgd29ya3NwYWNlLFxuICAgICAgICB7IC4uLnByb2Nlc3MuZW52LCBDSEVDS19ST09UUzogSlNPTi5zdHJpbmdpZnkoW3Jvb3RdKSB9LFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09IFwiY29tcGlsZXJcIiB8fCBtb2RlID09PSBcImNvbXBpbGVyLWluc3RhbGxcIikge1xuICAgICAgY29uc3Qgc2VsZWN0aW9uID0gW1xuICAgICAgICBcIi0tY29tcGlsZXJcIixcbiAgICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuQ09NUElMRVIsIFwiQ09NUElMRVIgaXMgcmVxdWlyZWRcIiksXG4gICAgICAgIFwiLS1jb21waWxlci12ZXJzaW9uXCIsXG4gICAgICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LkNPTVBJTEVSX1ZFUlNJT04sIFwiQ09NUElMRVJfVkVSU0lPTiBpcyByZXF1aXJlZFwiKSxcbiAgICAgIF07XG4gICAgICBpZiAobW9kZSA9PT0gXCJjb21waWxlci1pbnN0YWxsXCIpIGNsaShcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCByb290LCAuLi5zZWxlY3Rpb24pO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNvbnN0IHJvbGVzOiB1bmtub3duID0gSlNPTi5wYXJzZShwcm9jZXNzLmVudi5DSEVDS19ST0xFUyA/PyBcIltdXCIpO1xuICAgICAgICBpZiAoIWlzU3RyaW5nQXJyYXkocm9sZXMpIHx8ICFyb2xlcy5sZW5ndGggfHwgcm9sZXMuc29tZSgocm9sZSkgPT4gIWNvbXBpbGVyQ29tcGF0aWJpbGl0eVJvbGVzLmluY2x1ZGVzKHJvbGUpKSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDSEVDS19ST0xFUyBtdXN0IGxpc3QgY29tcGlsZXIgY29tcGF0aWJpbGl0eSByb2xlc1wiKTtcbiAgICAgICAgZm9yIChjb25zdCByb2xlIG9mIHJvbGVzKSBjbGkoXCJjaGVja1wiLCBcIi0tcm9sZVwiLCByb2xlLCBcIi0tcGF0aFwiLCByb290LCBcIi0tZW52aXJvbm1lbnRcIiwgXCJuYXRpdmVcIiwgLi4uc2VsZWN0aW9uKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIENJIG1vZGU6ICR7bW9kZX1gKTtcbiAgICBzdWNjZXNzZnVsLnB1c2gocm9vdCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbGVkID0gdHJ1ZTtcbiAgICBjb25zb2xlLmVycm9yKGA6OmVycm9yOjoke3Jvb3R9OiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCk7XG4gIH0gZmluYWxseSB7XG4gICAgY29uc29sZS5sb2coXCI6OmVuZGdyb3VwOjpcIik7XG4gIH1cbn1cbmlmIChbXCJuYXRpdmVcIiwgXCJuYXRpdmUtaW5zdGFsbFwiLCBcIm5hdGl2ZS1jaGVja1wiLCBcInJlbGVhc2VcIl0uaW5jbHVkZXMobW9kZSkgJiYgcHJvY2Vzcy5lbnYuR0lUSFVCX09VVFBVVClcbiAgYXBwZW5kRmlsZVN5bmMocHJvY2Vzcy5lbnYuR0lUSFVCX09VVFBVVCwgYHJvb3RzPSR7SlNPTi5zdHJpbmdpZnkoc3VjY2Vzc2Z1bCl9XFxuYCk7XG5pZiAoZmFpbGVkKSBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsZUFBZSxVQUFVLFFBQVEsUUFBUSxvQkFBb0I7QUFDdEUsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxnQkFBZ0IsV0FBVyxxQkFBcUI7QUFDekQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsa0NBQWtDO0FBRTNDLE1BQU0sUUFBaUIsS0FBSyxNQUFNLFFBQVEsSUFBSSxlQUFlLElBQUk7QUFDakUsSUFBSSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUMsTUFBTSxVQUFVLE1BQU0sS0FBSyxDQUFDLFNBQVMsT0FBTyxTQUFTLFlBQVksQ0FBQyxJQUFJO0FBQ2xHLFFBQU0sSUFBSSxNQUFNLHdDQUF3QztBQUMxRCxNQUFNLFlBQVksUUFBUSxJQUFJO0FBQzlCLE1BQU0sZUFBZSxRQUFRLElBQUksK0JBQStCO0FBQ2hFLE1BQU0sT0FBTyxTQUFTLFFBQVEsS0FBSyxDQUFDLEdBQUcsaUJBQWlCO0FBQ3hELFNBQVMsSUFBSSxTQUFpQixNQUFnQixNQUFNLFdBQVcsTUFBTSxRQUFRLEtBQUssVUFBVSxPQUFPO0FBQ2pHLFFBQU0sU0FBUyxVQUFVLFNBQVMsTUFBTTtBQUFBLElBQ3RDO0FBQUEsSUFDQTtBQUFBLElBQ0Es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QUFDO0FBQzdGLGNBQU0sSUFBSSxNQUFNLDhDQUE4QztBQUNoRTtBQUFBLFFBQ0UsUUFBUTtBQUFBLFFBQ1IsQ0FBQyxLQUFLLGNBQWMsbUJBQW1CLEdBQUcsc0JBQXNCLE1BQU0sU0FBUyxTQUFTLFVBQVU7QUFBQSxRQUNsRztBQUFBLFFBQ0EsRUFBRSxHQUFHLFFBQVEsS0FBSyxhQUFhLEtBQUssVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFO0FBQUEsTUFDeEQ7QUFBQSxJQUNGLFdBQVcsU0FBUyxjQUFjLFNBQVMsb0JBQW9CO0FBQzdELFlBQU0sWUFBWTtBQUFBLFFBQ2hCO0FBQUEsUUFDQSxTQUFTLFFBQVEsSUFBSSxVQUFVLHNCQUFzQjtBQUFBLFFBQ3JEO0FBQUEsUUFDQSxTQUFTLFFBQVEsSUFBSSxrQkFBa0IsOEJBQThCO0FBQUEsTUFDdkU7QUFDQSxVQUFJLFNBQVMsbUJBQW9CLEtBQUksU0FBUyxXQUFXLFVBQVUsTUFBTSxHQUFHLFNBQVM7QUFBQSxXQUNoRjtBQUNILGNBQU0sUUFBaUIsS0FBSyxNQUFNLFFBQVEsSUFBSSxlQUFlLElBQUk7QUFDakUsWUFBSSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUMsTUFBTSxVQUFVLE1BQU0sS0FBSyxDQUFDLFNBQVMsQ0FBQywyQkFBMkIsU0FBUyxJQUFJLENBQUM7QUFDM0csZ0JBQU0sSUFBSSxNQUFNLG9EQUFvRDtBQUN0RSxtQkFBVyxRQUFRLE1BQU8sS0FBSSxTQUFTLFVBQVUsTUFBTSxVQUFVLE1BQU0saUJBQWlCLFVBQVUsR0FBRyxTQUFTO0FBQUEsTUFDaEg7QUFBQSxJQUNGLE1BQU8sT0FBTSxJQUFJLE1BQU0sb0JBQW9CLElBQUksRUFBRTtBQUNqRCxlQUFXLEtBQUssSUFBSTtBQUFBLEVBQ3RCLFNBQVMsT0FBTztBQUNkLGFBQVM7QUFDVCxZQUFRLE1BQU0sWUFBWSxJQUFJLEtBQUssYUFBYSxLQUFLLENBQUMsRUFBRTtBQUFBLEVBQzFELFVBQUU7QUFDQSxZQUFRLElBQUksY0FBYztBQUFBLEVBQzVCO0FBQ0Y7QUFDQSxJQUFJLENBQUMsVUFBVSxrQkFBa0IsZ0JBQWdCLFNBQVMsRUFBRSxTQUFTLElBQUksS0FBSyxRQUFRLElBQUk7QUFDeEYsaUJBQWUsUUFBUSxJQUFJLGVBQWUsU0FBUyxLQUFLLFVBQVUsVUFBVSxDQUFDO0FBQUEsQ0FBSTtBQUNuRixJQUFJLE9BQVEsU0FBUSxXQUFXOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvY2ktcnVuLm1qcyJ9
