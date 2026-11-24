// Generated from job.mts; edit the TypeScript source.
import { required, errorFrom } from "../../app/src/core/runtime/values.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executeCITargets } from "../../app/src/core/execution/ci/support/ci-execution.mjs";
import { CIOperation } from "../../app/src/core/execution/ci/support/ci-operations.mjs";
import {
  createRunReport,
  parseRunReport,
  runSucceeded,
  writeRunReport
} from "../../app/src/core/execution/ci/support/ci-results.mjs";
import { parseCIWorkerRequest } from "../../app/src/core/execution/ci/support/ci-worker-request.mjs";
const { workspace, distribution, target, operation, reports, image, profile, cache, shared, adapter, uid, gid } = parseCIWorkerRequest(JSON.parse(readFileSync(required(process.argv[2], "Missing worker request path"), "utf8")));
function execute(command, args, env = process.env) {
  const child = spawnSync(command, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
const operationEnvironment = {
  ...operation === void 0 ? {} : { WORKBENCH_CI_OPERATION: operation },
  ...operation !== void 0 && operation !== CIOperation.Checks ? { WORKBENCH_CI_INSTALL_PREREQUISITES: "1" } : {}
};
const run = createRunReport([target.id], reports);
const results = join(reports, "job-results.json");
writeRunReport(results, run);
try {
  if (profile) {
    const selection = join(reports, "targets.json");
    writeFileSync(selection, JSON.stringify([target]));
    let failure;
    try {
      execute(
        process.execPath,
        [
          join(distribution, "bin/workbench.mjs"),
          "ci-image-job",
          profile,
          "--local-image",
          required(image, "Missing worker image"),
          "--targets",
          selection,
          "--reports",
          reports,
          ...operation === void 0 ? [] : ["--operation", operation]
        ],
        { ...process.env, ...shared }
      );
    } catch (error) {
      failure = errorFrom(error);
    }
    const returned = parseRunReport(JSON.parse(readFileSync(results, "utf8")), [target.id], reports);
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (failure && (runSucceeded(returned) || returned.targets.some((result) => result.finished === void 0)))
      throw failure;
  } else if (target.kind === "environment") {
    const env = {
      ...process.env,
      ...shared,
      WORKBENCH_PROJECT_ROOT: workspace,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_CI_DOCKER: adapter
    };
    if (target.environment === "devcontainer")
      execute(process.execPath, [join(distribution, "bin/workbench.mjs"), "tools", "install", "--devcontainer"], env);
    const result = await executeCITargets({
      targets: [target],
      workspace,
      distribution,
      reports,
      resultFile: results,
      env,
      ...operation === void 0 ? {} : { operation }
    });
    run.targets = result.targets;
    run.errors = result.errors;
  } else {
    mkdirSync(join(reports, "home"), { recursive: true });
    writeFileSync(join(reports, "targets.json"), JSON.stringify([target]));
    const guestDistribution = `/workspace/${relative(workspace, distribution)}`;
    let containerError;
    try {
      execute("docker", [
        "run",
        "--rm",
        "--label",
        `workbench.ci.workspace=${workspace}`,
        "--network=host",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        `${String(uid)}:${String(gid)}`,
        "--workdir",
        "/workspace",
        ...[
          [workspace, "/workspace"],
          [cache, cache],
          [reports, "/reports"]
        ].flatMap(([source, destination]) => {
          if (source.includes(",")) throw new Error("Docker bind mounts do not support commas in source paths");
          return ["--mount", `type=bind,src=${source},dst=${destination}`];
        }),
        ...Object.entries({
          ...shared,
          ...operationEnvironment,
          HOME: "/reports/home",
          RUNNER_TEMP: "/reports",
          TMPDIR: "/tmp",
          WORKBENCH_DISTRIBUTION_ROOT: guestDistribution,
          WORKBENCH_PROJECT_ROOT: "/workspace",
          WORKBENCH_CI_TARGETS: "/reports/targets.json"
        }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        required(image, "Missing worker image"),
        "node",
        `${guestDistribution}/scripts/ci-linux/run.mjs`
      ]);
    } catch (error) {
      containerError = errorFrom(error);
    }
    const returned = parseRunReport(
      JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")),
      [target.id],
      reports
    );
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (containerError && (runSucceeded(returned) || returned.targets.some((result) => result.finished === void 0)))
      throw containerError;
  }
} catch (error) {
  run.errors.push({
    phase: "target execution or results",
    message: error instanceof Error ? error.message : String(error)
  });
} finally {
  writeRunReport(results, run);
}
if (!runSucceeded(run)) process.exitCode = 1;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImpvYi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGVycm9yRnJvbSB9IGZyb20gXCIuLi8uLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4ZWN1dGVDSVRhcmdldHMgfSBmcm9tIFwiLi4vLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaS9zdXBwb3J0L2NpLWV4ZWN1dGlvbi5tanNcIjtcbmltcG9ydCB7IENJT3BlcmF0aW9uIH0gZnJvbSBcIi4uLy4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vY2kvc3VwcG9ydC9jaS1vcGVyYXRpb25zLm1qc1wiO1xuaW1wb3J0IHtcbiAgY3JlYXRlUnVuUmVwb3J0LFxuICBwYXJzZVJ1blJlcG9ydCxcbiAgcnVuU3VjY2VlZGVkLFxuICB3cml0ZVJ1blJlcG9ydCxcbn0gZnJvbSBcIi4uLy4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vY2kvc3VwcG9ydC9jaS1yZXN1bHRzLm1qc1wiO1xuaW1wb3J0IHsgcGFyc2VDSVdvcmtlclJlcXVlc3QgfSBmcm9tIFwiLi4vLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaS9zdXBwb3J0L2NpLXdvcmtlci1yZXF1ZXN0Lm1qc1wiO1xuXG4vLyBUaGlzIHByaXZhdGUgcmVxdWVzdCBpcyBjcmVhdGVkIGJ5IHRoZSBjb29yZGluYXRvciBmcm9tIGl0cyBmcm96ZW4gc291cmNlIHNuYXBzaG90LlxuY29uc3QgeyB3b3Jrc3BhY2UsIGRpc3RyaWJ1dGlvbiwgdGFyZ2V0LCBvcGVyYXRpb24sIHJlcG9ydHMsIGltYWdlLCBwcm9maWxlLCBjYWNoZSwgc2hhcmVkLCBhZGFwdGVyLCB1aWQsIGdpZCB9ID1cbiAgcGFyc2VDSVdvcmtlclJlcXVlc3QoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5hcmd2WzJdLCBcIk1pc3Npbmcgd29ya2VyIHJlcXVlc3QgcGF0aFwiKSwgXCJ1dGY4XCIpKSk7XG5mdW5jdGlvbiBleGVjdXRlKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIGVudiA9IHByb2Nlc3MuZW52KSB7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHsgY3dkOiB3b3Jrc3BhY2UsIGVudiwgc3RkaW86IFwiaW5oZXJpdFwiIH0pO1xuICBpZiAoY2hpbGQuZXJyb3IgfHwgY2hpbGQuc3RhdHVzICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyBjaGlsZC5zdGF0dXMpfWApO1xufVxuY29uc3Qgb3BlcmF0aW9uRW52aXJvbm1lbnQgPSB7XG4gIC4uLihvcGVyYXRpb24gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBXT1JLQkVOQ0hfQ0lfT1BFUkFUSU9OOiBvcGVyYXRpb24gfSksXG4gIC4uLihvcGVyYXRpb24gIT09IHVuZGVmaW5lZCAmJiBvcGVyYXRpb24gIT09IENJT3BlcmF0aW9uLkNoZWNrcyA/IHsgV09SS0JFTkNIX0NJX0lOU1RBTExfUFJFUkVRVUlTSVRFUzogXCIxXCIgfSA6IHt9KSxcbn07XG5jb25zdCBydW4gPSBjcmVhdGVSdW5SZXBvcnQoW3RhcmdldC5pZF0sIHJlcG9ydHMpO1xuY29uc3QgcmVzdWx0cyA9IGpvaW4ocmVwb3J0cywgXCJqb2ItcmVzdWx0cy5qc29uXCIpO1xud3JpdGVSdW5SZXBvcnQocmVzdWx0cywgcnVuKTtcbnRyeSB7XG4gIGlmIChwcm9maWxlKSB7XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gam9pbihyZXBvcnRzLCBcInRhcmdldHMuanNvblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHNlbGVjdGlvbiwgSlNPTi5zdHJpbmdpZnkoW3RhcmdldF0pKTtcbiAgICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGV4ZWN1dGUoXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtcbiAgICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICBcImNpLWltYWdlLWpvYlwiLFxuICAgICAgICAgIHByb2ZpbGUsXG4gICAgICAgICAgXCItLWxvY2FsLWltYWdlXCIsXG4gICAgICAgICAgcmVxdWlyZWQoaW1hZ2UsIFwiTWlzc2luZyB3b3JrZXIgaW1hZ2VcIiksXG4gICAgICAgICAgXCItLXRhcmdldHNcIixcbiAgICAgICAgICBzZWxlY3Rpb24sXG4gICAgICAgICAgXCItLXJlcG9ydHNcIixcbiAgICAgICAgICByZXBvcnRzLFxuICAgICAgICAgIC4uLihvcGVyYXRpb24gPT09IHVuZGVmaW5lZCA/IFtdIDogW1wiLS1vcGVyYXRpb25cIiwgb3BlcmF0aW9uXSksXG4gICAgICAgIF0sXG4gICAgICAgIHsgLi4ucHJvY2Vzcy5lbnYsIC4uLnNoYXJlZCB9LFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZmFpbHVyZSA9IGVycm9yRnJvbShlcnJvcik7XG4gICAgfVxuICAgIGNvbnN0IHJldHVybmVkID0gcGFyc2VSdW5SZXBvcnQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVzdWx0cywgXCJ1dGY4XCIpKSwgW3RhcmdldC5pZF0sIHJlcG9ydHMpO1xuICAgIHJ1bi50YXJnZXRzID0gcmV0dXJuZWQudGFyZ2V0cztcbiAgICBydW4uZXJyb3JzID0gcmV0dXJuZWQuZXJyb3JzO1xuICAgIGlmIChmYWlsdXJlICYmIChydW5TdWNjZWVkZWQocmV0dXJuZWQpIHx8IHJldHVybmVkLnRhcmdldHMuc29tZSgocmVzdWx0KSA9PiByZXN1bHQuZmluaXNoZWQgPT09IHVuZGVmaW5lZCkpKVxuICAgICAgdGhyb3cgZmFpbHVyZTtcbiAgfSBlbHNlIGlmICh0YXJnZXQua2luZCA9PT0gXCJlbnZpcm9ubWVudFwiKSB7XG4gICAgY29uc3QgZW52ID0ge1xuICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAuLi5zaGFyZWQsXG4gICAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiB3b3Jrc3BhY2UsXG4gICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGRpc3RyaWJ1dGlvbixcbiAgICAgIFdPUktCRU5DSF9DSV9ET0NLRVI6IGFkYXB0ZXIsXG4gICAgfTtcbiAgICBpZiAodGFyZ2V0LmVudmlyb25tZW50ID09PSBcImRldmNvbnRhaW5lclwiKVxuICAgICAgZXhlY3V0ZShwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS1kZXZjb250YWluZXJcIl0sIGVudik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZUNJVGFyZ2V0cyh7XG4gICAgICB0YXJnZXRzOiBbdGFyZ2V0XSxcbiAgICAgIHdvcmtzcGFjZSxcbiAgICAgIGRpc3RyaWJ1dGlvbixcbiAgICAgIHJlcG9ydHMsXG4gICAgICByZXN1bHRGaWxlOiByZXN1bHRzLFxuICAgICAgZW52LFxuICAgICAgLi4uKG9wZXJhdGlvbiA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG9wZXJhdGlvbiB9KSxcbiAgICB9KTtcbiAgICBydW4udGFyZ2V0cyA9IHJlc3VsdC50YXJnZXRzO1xuICAgIHJ1bi5lcnJvcnMgPSByZXN1bHQuZXJyb3JzO1xuICB9IGVsc2Uge1xuICAgIG1rZGlyU3luYyhqb2luKHJlcG9ydHMsIFwiaG9tZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG9ydHMsIFwidGFyZ2V0cy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShbdGFyZ2V0XSkpO1xuICAgIGNvbnN0IGd1ZXN0RGlzdHJpYnV0aW9uID0gYC93b3Jrc3BhY2UvJHtyZWxhdGl2ZSh3b3Jrc3BhY2UsIGRpc3RyaWJ1dGlvbil9YDtcbiAgICBsZXQgY29udGFpbmVyRXJyb3I6IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBleGVjdXRlKFwiZG9ja2VyXCIsIFtcbiAgICAgICAgXCJydW5cIixcbiAgICAgICAgXCItLXJtXCIsXG4gICAgICAgIFwiLS1sYWJlbFwiLFxuICAgICAgICBgd29ya2JlbmNoLmNpLndvcmtzcGFjZT0ke3dvcmtzcGFjZX1gLFxuICAgICAgICBcIi0tbmV0d29yaz1ob3N0XCIsXG4gICAgICAgIFwiLS1jYXAtZHJvcD1BTExcIixcbiAgICAgICAgXCItLXNlY3VyaXR5LW9wdD1uby1uZXctcHJpdmlsZWdlc1wiLFxuICAgICAgICBcIi0tdXNlclwiLFxuICAgICAgICBgJHtTdHJpbmcodWlkKX06JHtTdHJpbmcoZ2lkKX1gLFxuICAgICAgICBcIi0td29ya2RpclwiLFxuICAgICAgICBcIi93b3Jrc3BhY2VcIixcbiAgICAgICAgLi4uKFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFt3b3Jrc3BhY2UsIFwiL3dvcmtzcGFjZVwiXSxcbiAgICAgICAgICAgIFtjYWNoZSwgY2FjaGVdLFxuICAgICAgICAgICAgW3JlcG9ydHMsIFwiL3JlcG9ydHNcIl0sXG4gICAgICAgICAgXSBhcyBjb25zdFxuICAgICAgICApLmZsYXRNYXAoKFtzb3VyY2UsIGRlc3RpbmF0aW9uXSkgPT4ge1xuICAgICAgICAgIGlmIChzb3VyY2UuaW5jbHVkZXMoXCIsXCIpKSB0aHJvdyBuZXcgRXJyb3IoXCJEb2NrZXIgYmluZCBtb3VudHMgZG8gbm90IHN1cHBvcnQgY29tbWFzIGluIHNvdXJjZSBwYXRoc1wiKTtcbiAgICAgICAgICByZXR1cm4gW1wiLS1tb3VudFwiLCBgdHlwZT1iaW5kLHNyYz0ke3NvdXJjZX0sZHN0PSR7ZGVzdGluYXRpb259YF07XG4gICAgICAgIH0pLFxuICAgICAgICAuLi5PYmplY3QuZW50cmllcyh7XG4gICAgICAgICAgLi4uc2hhcmVkLFxuICAgICAgICAgIC4uLm9wZXJhdGlvbkVudmlyb25tZW50LFxuICAgICAgICAgIEhPTUU6IFwiL3JlcG9ydHMvaG9tZVwiLFxuICAgICAgICAgIFJVTk5FUl9URU1QOiBcIi9yZXBvcnRzXCIsXG4gICAgICAgICAgVE1QRElSOiBcIi90bXBcIixcbiAgICAgICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGd1ZXN0RGlzdHJpYnV0aW9uLFxuICAgICAgICAgIFdPUktCRU5DSF9QUk9KRUNUX1JPT1Q6IFwiL3dvcmtzcGFjZVwiLFxuICAgICAgICAgIFdPUktCRU5DSF9DSV9UQVJHRVRTOiBcIi9yZXBvcnRzL3RhcmdldHMuanNvblwiLFxuICAgICAgICB9KS5mbGF0TWFwKChba2V5LCB2YWx1ZV0pID0+IFtcIi0tZW52XCIsIGAke2tleX09JHt2YWx1ZX1gXSksXG4gICAgICAgIHJlcXVpcmVkKGltYWdlLCBcIk1pc3Npbmcgd29ya2VyIGltYWdlXCIpLFxuICAgICAgICBcIm5vZGVcIixcbiAgICAgICAgYCR7Z3Vlc3REaXN0cmlidXRpb259L3NjcmlwdHMvY2ktbGludXgvcnVuLm1qc2AsXG4gICAgICBdKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29udGFpbmVyRXJyb3IgPSBlcnJvckZyb20oZXJyb3IpO1xuICAgIH1cbiAgICBjb25zdCByZXR1cm5lZCA9IHBhcnNlUnVuUmVwb3J0KFxuICAgICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyZXBvcnRzLCBcImd1ZXN0LXJlc3VsdHMuanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgICAgIFt0YXJnZXQuaWRdLFxuICAgICAgcmVwb3J0cyxcbiAgICApO1xuICAgIHJ1bi50YXJnZXRzID0gcmV0dXJuZWQudGFyZ2V0cztcbiAgICBydW4uZXJyb3JzID0gcmV0dXJuZWQuZXJyb3JzO1xuICAgIGlmIChjb250YWluZXJFcnJvciAmJiAocnVuU3VjY2VlZGVkKHJldHVybmVkKSB8fCByZXR1cm5lZC50YXJnZXRzLnNvbWUoKHJlc3VsdCkgPT4gcmVzdWx0LmZpbmlzaGVkID09PSB1bmRlZmluZWQpKSlcbiAgICAgIHRocm93IGNvbnRhaW5lckVycm9yO1xuICB9XG59IGNhdGNoIChlcnJvcikge1xuICBydW4uZXJyb3JzLnB1c2goe1xuICAgIHBoYXNlOiBcInRhcmdldCBleGVjdXRpb24gb3IgcmVzdWx0c1wiLFxuICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcbiAgfSk7XG59IGZpbmFsbHkge1xuICB3cml0ZVJ1blJlcG9ydChyZXN1bHRzLCBydW4pO1xufVxuaWYgKCFydW5TdWNjZWVkZWQocnVuKSkgcHJvY2Vzcy5leGl0Q29kZSA9IDE7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsaUJBQWlCO0FBQ3BDLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsV0FBVyxjQUFjLHFCQUFxQjtBQUN2RCxTQUFTLE1BQU0sZ0JBQWdCO0FBQy9CLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsbUJBQW1CO0FBQzVCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDRCQUE0QjtBQUdyQyxNQUFNLEVBQUUsV0FBVyxjQUFjLFFBQVEsV0FBVyxTQUFTLE9BQU8sU0FBUyxPQUFPLFFBQVEsU0FBUyxLQUFLLElBQUksSUFDNUcscUJBQXFCLEtBQUssTUFBTSxhQUFhLFNBQVMsUUFBUSxLQUFLLENBQUMsR0FBRyw2QkFBNkIsR0FBRyxNQUFNLENBQUMsQ0FBQztBQUNqSCxTQUFTLFFBQVEsU0FBaUIsTUFBeUIsTUFBTSxRQUFRLEtBQUs7QUFDNUUsUUFBTSxRQUFRLFVBQVUsU0FBUyxNQUFNLEVB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QUcsT0FBTyxHQUFHLENBQUMsSUFBSSxPQUFPLEdBQUcsQ0FBQztBQUFBLFFBQzdCO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FDRTtBQUFBLFVBQ0UsQ0FBQyxXQUFXLFlBQVk7QUFBQSxVQUN4QixDQUFDLE9BQU8sS0FBSztBQUFBLFVBQ2IsQ0FBQyxTQUFTLFVBQVU7QUFBQSxRQUN0QixFQUNBLFFBQVEsQ0FBQyxDQUFDLFFBQVEsV0FBVyxNQUFNO0FBQ25DLGNBQUksT0FBTyxTQUFTLEdBQUcsRUFBRyxPQUFNLElBQUksTUFBTSwwREFBMEQ7QUFDcEcsaUJBQU8sQ0FBQyxXQUFXLGlCQUFpQixNQUFNLFFBQVEsV0FBVyxFQUFFO0FBQUEsUUFDakUsQ0FBQztBQUFBLFFBQ0QsR0FBRyxPQUFPLFFBQVE7QUFBQSxVQUNoQixHQUFHO0FBQUEsVUFDSCxHQUFHO0FBQUEsVUFDSCxNQUFNO0FBQUEsVUFDTixhQUFhO0FBQUEsVUFDYixRQUFRO0FBQUEsVUFDUiw2QkFBNkI7QUFBQSxVQUM3Qix3QkFBd0I7QUFBQSxVQUN4QixzQkFBc0I7QUFBQSxRQUN4QixDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxTQUFTLEdBQUcsR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDO0FBQUEsUUFDekQsU0FBUyxPQUFPLHNCQUFzQjtBQUFBLFFBQ3RDO0FBQUEsUUFDQSxHQUFHLGlCQUFpQjtBQUFBLE1BQ3RCLENBQUM7QUFBQSxJQUNILFNBQVMsT0FBTztBQUNkLHVCQUFpQixVQUFVLEtBQUs7QUFBQSxJQUNsQztBQUNBLFVBQU0sV0FBVztBQUFBLE1BQ2YsS0FBSyxNQUFNLGFBQWEsS0FBSyxTQUFTLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUFBLE1BQ3BFLENBQUMsT0FBTyxFQUFFO0FBQUEsTUFDVjtBQUFBLElBQ0Y7QUFDQSxRQUFJLFVBQVUsU0FBUztBQUN2QixRQUFJLFNBQVMsU0FBUztBQUN0QixRQUFJLG1CQUFtQixhQUFhLFFBQVEsS0FBSyxTQUFTLFFBQVEsS0FBSyxDQUFDLFdBQVcsT0FBTyxhQUFhLE1BQVM7QUFDOUcsWUFBTTtBQUFBLEVBQ1Y7QUFDRixTQUFTLE9BQU87QUFDZCxNQUFJLE9BQU8sS0FBSztBQUFBLElBQ2QsT0FBTztBQUFBLElBQ1AsU0FBUyxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQUEsRUFDaEUsQ0FBQztBQUNILFVBQUU7QUFDQSxpQkFBZSxTQUFTLEdBQUc7QUFDN0I7QUFDQSxJQUFJLENBQUMsYUFBYSxHQUFHLEVBQUcsU0FBUSxXQUFXOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvY2ktbGludXgvam9iLm1qcyJ9
