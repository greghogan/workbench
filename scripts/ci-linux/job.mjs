// Generated from job.mts; edit the TypeScript source.
import { required, errorFrom } from "../values.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executeCITargets } from "../ci-execution.mjs";
import { CIOperation } from "../ci-operations.mjs";
import { createRunReport, parseRunReport, runSucceeded, writeRunReport } from "../ci-results.mjs";
import { parseCIWorkerRequest } from "../ci-worker-request.mjs";
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
    writeFileSync(join(reports, "targets.json"), JSON.stringify([target]));
    const env = {
      ...operationEnvironment,
      RUNNER_TEMP: "/reports",
      WORKBENCH_CI_TARGETS: "/reports/targets.json",
      WORKBENCH_CPU_BUDGET: shared.WORKBENCH_CPU_BUDGET,
      ...shared.WORKBENCH_CPUS === void 0 ? {} : { WORKBENCH_CPUS: shared.WORKBENCH_CPUS }
    };
    let failure;
    try {
      execute(process.execPath, [
        join(distribution, "bin/workbench.mjs"),
        "ci-image-exec",
        profile,
        "--image",
        required(image, "Missing worker image"),
        "--reports",
        reports,
        "--env-json",
        JSON.stringify(env),
        "--",
        "node",
        "{workbench}/scripts/ci-linux/run.mjs"
      ]);
    } catch (error) {
      failure = errorFrom(error);
    }
    const returned = parseRunReport(
      JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")),
      [target.id],
      reports
    );
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (failure && runSucceeded(returned)) throw failure;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImpvYi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGVycm9yRnJvbSB9IGZyb20gXCIuLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4ZWN1dGVDSVRhcmdldHMgfSBmcm9tIFwiLi4vY2ktZXhlY3V0aW9uLm1qc1wiO1xuaW1wb3J0IHsgQ0lPcGVyYXRpb24gfSBmcm9tIFwiLi4vY2ktb3BlcmF0aW9ucy5tanNcIjtcbmltcG9ydCB7IGNyZWF0ZVJ1blJlcG9ydCwgcGFyc2VSdW5SZXBvcnQsIHJ1blN1Y2NlZWRlZCwgd3JpdGVSdW5SZXBvcnQgfSBmcm9tIFwiLi4vY2ktcmVzdWx0cy5tanNcIjtcbmltcG9ydCB7IHBhcnNlQ0lXb3JrZXJSZXF1ZXN0IH0gZnJvbSBcIi4uL2NpLXdvcmtlci1yZXF1ZXN0Lm1qc1wiO1xuXG4vLyBUaGlzIHByaXZhdGUgcmVxdWVzdCBpcyBjcmVhdGVkIGJ5IHRoZSBjb29yZGluYXRvciBmcm9tIGl0cyBmcm96ZW4gc291cmNlIHNuYXBzaG90LlxuY29uc3QgeyB3b3Jrc3BhY2UsIGRpc3RyaWJ1dGlvbiwgdGFyZ2V0LCBvcGVyYXRpb24sIHJlcG9ydHMsIGltYWdlLCBwcm9maWxlLCBjYWNoZSwgc2hhcmVkLCBhZGFwdGVyLCB1aWQsIGdpZCB9ID1cbiAgcGFyc2VDSVdvcmtlclJlcXVlc3QoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5hcmd2WzJdLCBcIk1pc3Npbmcgd29ya2VyIHJlcXVlc3QgcGF0aFwiKSwgXCJ1dGY4XCIpKSk7XG5mdW5jdGlvbiBleGVjdXRlKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIGVudiA9IHByb2Nlc3MuZW52KSB7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHsgY3dkOiB3b3Jrc3BhY2UsIGVudiwgc3RkaW86IFwiaW5oZXJpdFwiIH0pO1xuICBpZiAoY2hpbGQuZXJyb3IgfHwgY2hpbGQuc3RhdHVzICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyBjaGlsZC5zdGF0dXMpfWApO1xufVxuY29uc3Qgb3BlcmF0aW9uRW52aXJvbm1lbnQgPSB7XG4gIC4uLihvcGVyYXRpb24gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBXT1JLQkVOQ0hfQ0lfT1BFUkFUSU9OOiBvcGVyYXRpb24gfSksXG4gIC4uLihvcGVyYXRpb24gIT09IHVuZGVmaW5lZCAmJiBvcGVyYXRpb24gIT09IENJT3BlcmF0aW9uLkNoZWNrcyA/IHsgV09SS0JFTkNIX0NJX0lOU1RBTExfUFJFUkVRVUlTSVRFUzogXCIxXCIgfSA6IHt9KSxcbn07XG5jb25zdCBydW4gPSBjcmVhdGVSdW5SZXBvcnQoW3RhcmdldC5pZF0sIHJlcG9ydHMpO1xuY29uc3QgcmVzdWx0cyA9IGpvaW4ocmVwb3J0cywgXCJqb2ItcmVzdWx0cy5qc29uXCIpO1xud3JpdGVSdW5SZXBvcnQocmVzdWx0cywgcnVuKTtcbnRyeSB7XG4gIGlmIChwcm9maWxlKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG9ydHMsIFwidGFyZ2V0cy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShbdGFyZ2V0XSkpO1xuICAgIGNvbnN0IGVudiA9IHtcbiAgICAgIC4uLm9wZXJhdGlvbkVudmlyb25tZW50LFxuICAgICAgUlVOTkVSX1RFTVA6IFwiL3JlcG9ydHNcIixcbiAgICAgIFdPUktCRU5DSF9DSV9UQVJHRVRTOiBcIi9yZXBvcnRzL3RhcmdldHMuanNvblwiLFxuICAgICAgV09SS0JFTkNIX0NQVV9CVURHRVQ6IHNoYXJlZC5XT1JLQkVOQ0hfQ1BVX0JVREdFVCxcbiAgICAgIC4uLihzaGFyZWQuV09SS0JFTkNIX0NQVVMgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBXT1JLQkVOQ0hfQ1BVUzogc2hhcmVkLldPUktCRU5DSF9DUFVTIH0pLFxuICAgIH07XG4gICAgbGV0IGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBleGVjdXRlKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwiY2ktaW1hZ2UtZXhlY1wiLFxuICAgICAgICBwcm9maWxlLFxuICAgICAgICBcIi0taW1hZ2VcIixcbiAgICAgICAgcmVxdWlyZWQoaW1hZ2UsIFwiTWlzc2luZyB3b3JrZXIgaW1hZ2VcIiksXG4gICAgICAgIFwiLS1yZXBvcnRzXCIsXG4gICAgICAgIHJlcG9ydHMsXG4gICAgICAgIFwiLS1lbnYtanNvblwiLFxuICAgICAgICBKU09OLnN0cmluZ2lmeShlbnYpLFxuICAgICAgICBcIi0tXCIsXG4gICAgICAgIFwibm9kZVwiLFxuICAgICAgICBcInt3b3JrYmVuY2h9L3NjcmlwdHMvY2ktbGludXgvcnVuLm1qc1wiLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmUgPSBlcnJvckZyb20oZXJyb3IpO1xuICAgIH1cbiAgICBjb25zdCByZXR1cm5lZCA9IHBhcnNlUnVuUmVwb3J0KFxuICAgICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyZXBvcnRzLCBcImd1ZXN0LXJlc3VsdHMuanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgICAgIFt0YXJnZXQuaWRdLFxuICAgICAgcmVwb3J0cyxcbiAgICApO1xuICAgIHJ1bi50YXJnZXRzID0gcmV0dXJuZWQudGFyZ2V0cztcbiAgICBydW4uZXJyb3JzID0gcmV0dXJuZWQuZXJyb3JzO1xuICAgIGlmIChmYWlsdXJlICYmIHJ1blN1Y2NlZWRlZChyZXR1cm5lZCkpIHRocm93IGZhaWx1cmU7XG4gIH0gZWxzZSBpZiAodGFyZ2V0LmtpbmQgPT09IFwiZW52aXJvbm1lbnRcIikge1xuICAgIGNvbnN0IGVudiA9IHtcbiAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgLi4uc2hhcmVkLFxuICAgICAgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogd29ya3NwYWNlLFxuICAgICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBkaXN0cmlidXRpb24sXG4gICAgICBXT1JLQkVOQ0hfQ0lfRE9DS0VSOiBhZGFwdGVyLFxuICAgIH07XG4gICAgaWYgKHRhcmdldC5lbnZpcm9ubWVudCA9PT0gXCJkZXZjb250YWluZXJcIilcbiAgICAgIGV4ZWN1dGUocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tZGV2Y29udGFpbmVyXCJdLCBlbnYpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVDSVRhcmdldHMoe1xuICAgICAgdGFyZ2V0czogW3RhcmdldF0sXG4gICAgICB3b3Jrc3BhY2UsXG4gICAgICBkaXN0cmlidXRpb24sXG4gICAgICByZXBvcnRzLFxuICAgICAgcmVzdWx0RmlsZTogcmVzdWx0cyxcbiAgICAgIGVudixcbiAgICAgIC4uLihvcGVyYXRpb24gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBvcGVyYXRpb24gfSksXG4gICAgfSk7XG4gICAgcnVuLnRhcmdldHMgPSByZXN1bHQudGFyZ2V0cztcbiAgICBydW4uZXJyb3JzID0gcmVzdWx0LmVycm9ycztcbiAgfSBlbHNlIHtcbiAgICBta2RpclN5bmMoam9pbihyZXBvcnRzLCBcImhvbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvcnRzLCBcInRhcmdldHMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoW3RhcmdldF0pKTtcbiAgICBjb25zdCBndWVzdERpc3RyaWJ1dGlvbiA9IGAvd29ya3NwYWNlLyR7cmVsYXRpdmUod29ya3NwYWNlLCBkaXN0cmlidXRpb24pfWA7XG4gICAgbGV0IGNvbnRhaW5lckVycm9yOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgZXhlY3V0ZShcImRvY2tlclwiLCBbXG4gICAgICAgIFwicnVuXCIsXG4gICAgICAgIFwiLS1ybVwiLFxuICAgICAgICBcIi0tbGFiZWxcIixcbiAgICAgICAgYHdvcmtiZW5jaC5jaS53b3Jrc3BhY2U9JHt3b3Jrc3BhY2V9YCxcbiAgICAgICAgXCItLW5ldHdvcms9aG9zdFwiLFxuICAgICAgICBcIi0tY2FwLWRyb3A9QUxMXCIsXG4gICAgICAgIFwiLS1zZWN1cml0eS1vcHQ9bm8tbmV3LXByaXZpbGVnZXNcIixcbiAgICAgICAgXCItLXVzZXJcIixcbiAgICAgICAgYCR7U3RyaW5nKHVpZCl9OiR7U3RyaW5nKGdpZCl9YCxcbiAgICAgICAgXCItLXdvcmtkaXJcIixcbiAgICAgICAgXCIvd29ya3NwYWNlXCIsXG4gICAgICAgIC4uLihcbiAgICAgICAgICBbXG4gICAgICAgICAgICBbd29ya3NwYWNlLCBcIi93b3Jrc3BhY2VcIl0sXG4gICAgICAgICAgICBbY2FjaGUsIGNhY2hlXSxcbiAgICAgICAgICAgIFtyZXBvcnRzLCBcIi9yZXBvcnRzXCJdLFxuICAgICAgICAgIF0gYXMgY29uc3RcbiAgICAgICAgKS5mbGF0TWFwKChbc291cmNlLCBkZXN0aW5hdGlvbl0pID0+IHtcbiAgICAgICAgICBpZiAoc291cmNlLmluY2x1ZGVzKFwiLFwiKSkgdGhyb3cgbmV3IEVycm9yKFwiRG9ja2VyIGJpbmQgbW91bnRzIGRvIG5vdCBzdXBwb3J0IGNvbW1hcyBpbiBzb3VyY2UgcGF0aHNcIik7XG4gICAgICAgICAgcmV0dXJuIFtcIi0tbW91bnRcIiwgYHR5cGU9YmluZCxzcmM9JHtzb3VyY2V9LGRzdD0ke2Rlc3RpbmF0aW9ufWBdO1xuICAgICAgICB9KSxcbiAgICAgICAgLi4uT2JqZWN0LmVudHJpZXMoe1xuICAgICAgICAgIC4uLnNoYXJlZCxcbiAgICAgICAgICAuLi5vcGVyYXRpb25FbnZpcm9ubWVudCxcbiAgICAgICAgICBIT01FOiBcIi9yZXBvcnRzL2hvbWVcIixcbiAgICAgICAgICBSVU5ORVJfVEVNUDogXCIvcmVwb3J0c1wiLFxuICAgICAgICAgIFRNUERJUjogXCIvdG1wXCIsXG4gICAgICAgICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBndWVzdERpc3RyaWJ1dGlvbixcbiAgICAgICAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiBcIi93b3Jrc3BhY2VcIixcbiAgICAgICAgICBXT1JLQkVOQ0hfQ0lfVEFSR0VUUzogXCIvcmVwb3J0cy90YXJnZXRzLmpzb25cIixcbiAgICAgICAgfSkuZmxhdE1hcCgoW2tleSwgdmFsdWVdKSA9PiBbXCItLWVudlwiLCBgJHtrZXl9PSR7dmFsdWV9YF0pLFxuICAgICAgICByZXF1aXJlZChpbWFnZSwgXCJNaXNzaW5nIHdvcmtlciBpbWFnZVwiKSxcbiAgICAgICAgXCJub2RlXCIsXG4gICAgICAgIGAke2d1ZXN0RGlzdHJpYnV0aW9ufS9zY3JpcHRzL2NpLWxpbnV4L3J1bi5tanNgLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnRhaW5lckVycm9yID0gZXJyb3JGcm9tKGVycm9yKTtcbiAgICB9XG4gICAgY29uc3QgcmV0dXJuZWQgPSBwYXJzZVJ1blJlcG9ydChcbiAgICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocmVwb3J0cywgXCJndWVzdC1yZXN1bHRzLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgICBbdGFyZ2V0LmlkXSxcbiAgICAgIHJlcG9ydHMsXG4gICAgKTtcbiAgICBydW4udGFyZ2V0cyA9IHJldHVybmVkLnRhcmdldHM7XG4gICAgcnVuLmVycm9ycyA9IHJldHVybmVkLmVycm9ycztcbiAgICBpZiAoY29udGFpbmVyRXJyb3IgJiYgKHJ1blN1Y2NlZWRlZChyZXR1cm5lZCkgfHwgcmV0dXJuZWQudGFyZ2V0cy5zb21lKChyZXN1bHQpID0+IHJlc3VsdC5maW5pc2hlZCA9PT0gdW5kZWZpbmVkKSkpXG4gICAgICB0aHJvdyBjb250YWluZXJFcnJvcjtcbiAgfVxufSBjYXRjaCAoZXJyb3IpIHtcbiAgcnVuLmVycm9ycy5wdXNoKHtcbiAgICBwaGFzZTogXCJ0YXJnZXQgZXhlY3V0aW9uIG9yIHJlc3VsdHNcIixcbiAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gIH0pO1xufSBmaW5hbGx5IHtcbiAgd3JpdGVSdW5SZXBvcnQocmVzdWx0cywgcnVuKTtcbn1cbmlmICghcnVuU3VjY2VlZGVkKHJ1bikpIHByb2Nlc3MuZXhpdENvZGUgPSAxO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxVQUFVLGlCQUFpQjtBQUNwQyxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLFdBQVcsY0FBYyxxQkFBcUI7QUFDdkQsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixTQUFTLHdCQUF3QjtBQUNqQyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGlCQUFpQixnQkFBZ0IsY0FBYyxzQkFBc0I7QUFDOUUsU0FBUyw0QkFBNEI7QUFHckMsTUFBTSxFQUFFLFdBQVcsY0FBYyxRQUFRLFdBQVcsU0FBUyxPQUFPLFNBQVMsT0FBTyxRQUFRLFNBQVMsS0FBSyxJQUFJLElBQzVHLHFCQUFxQixLQUFLLE1BQU0sYUFBYSxTQUFTLFFBQVEsS0FBSyxDQUFDLEdBQUcsNkJBQTZCLEdBQUcsTUFBTSxDQUFDLENBQUM7QUFDakgsU0FBUyxRQUFRLFNBQWlCLE1BQXlCLE1BQU0sUUFBUSxLQUFLO0FBQzVFLFFBQU0sUUFBUSxVQUFVLFNBQVMsTUFBTSxFQUFFLEtBQUssV0FBVyxLQUFLLE9BQU8s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O0FBQUEsUUFDbkM7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUcsT0FBTyxHQUFHLENBQUMsSUFBSSxPQUFPLEdBQUcsQ0FBQztBQUFBLFFBQzdCO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FDRTtBQUFBLFVBQ0UsQ0FBQyxXQUFXLFlBQVk7QUFBQSxVQUN4QixDQUFDLE9BQU8sS0FBSztBQUFBLFVBQ2IsQ0FBQyxTQUFTLFVBQVU7QUFBQSxRQUN0QixFQUNBLFFBQVEsQ0FBQyxDQUFDLFFBQVEsV0FBVyxNQUFNO0FBQ25DLGNBQUksT0FBTyxTQUFTLEdBQUcsRUFBRyxPQUFNLElBQUksTUFBTSwwREFBMEQ7QUFDcEcsaUJBQU8sQ0FBQyxXQUFXLGlCQUFpQixNQUFNLFFBQVEsV0FBVyxFQUFFO0FBQUEsUUFDakUsQ0FBQztBQUFBLFFBQ0QsR0FBRyxPQUFPLFFBQVE7QUFBQSxVQUNoQixHQUFHO0FBQUEsVUFDSCxHQUFHO0FBQUEsVUFDSCxNQUFNO0FBQUEsVUFDTixhQUFhO0FBQUEsVUFDYixRQUFRO0FBQUEsVUFDUiw2QkFBNkI7QUFBQSxVQUM3Qix3QkFBd0I7QUFBQSxVQUN4QixzQkFBc0I7QUFBQSxRQUN4QixDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxTQUFTLEdBQUcsR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDO0FBQUEsUUFDekQsU0FBUyxPQUFPLHNCQUFzQjtBQUFBLFFBQ3RDO0FBQUEsUUFDQSxHQUFHLGlCQUFpQjtBQUFBLE1BQ3RCLENBQUM7QUFBQSxJQUNILFNBQVMsT0FBTztBQUNkLHVCQUFpQixVQUFVLEtBQUs7QUFBQSxJQUNsQztBQUNBLFVBQU0sV0FBVztBQUFBLE1BQ2YsS0FBSyxNQUFNLGFBQWEsS0FBSyxTQUFTLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUFBLE1BQ3BFLENBQUMsT0FBTyxFQUFFO0FBQUEsTUFDVjtBQUFBLElBQ0Y7QUFDQSxRQUFJLFVBQVUsU0FBUztBQUN2QixRQUFJLFNBQVMsU0FBUztBQUN0QixRQUFJLG1CQUFtQixhQUFhLFFBQVEsS0FBSyxTQUFTLFFBQVEsS0FBSyxDQUFDLFdBQVcsT0FBTyxhQUFhLE1BQVM7QUFDOUcsWUFBTTtBQUFBLEVBQ1Y7QUFDRixTQUFTLE9BQU87QUFDZCxNQUFJLE9BQU8sS0FBSztBQUFBLElBQ2QsT0FBTztBQUFBLElBQ1AsU0FBUyxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQUEsRUFDaEUsQ0FBQztBQUNILFVBQUU7QUFDQSxpQkFBZSxTQUFTLEdBQUc7QUFDN0I7QUFDQSxJQUFJLENBQUMsYUFBYSxHQUFHLEVBQUcsU0FBUSxXQUFXOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvY2ktbGludXgvam9iLm1qcyJ9
