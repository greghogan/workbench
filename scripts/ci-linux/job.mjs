// Generated from job.mts; edit the TypeScript source.
import { required, errorFrom } from "../values.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { targetEnvironment, targetPhases } from "../ci-contract.mjs";
import { createRunReport, parseRunReport, runReportedTarget, runSucceeded, writeRunReport } from "../ci-results.mjs";
import { parseCIWorkerRequest } from "../ci-worker-request.mjs";
const { workspace, distribution, target, reports, image, profile, cache, shared, adapter, uid, gid } = parseCIWorkerRequest(JSON.parse(readFileSync(required(process.argv[2], "Missing worker request path"), "utf8")));
function execute(command, args, env = process.env) {
  const child = spawnSync(command, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
const run = createRunReport([target.id], reports);
const results = join(reports, "job-results.json");
writeRunReport(results, run);
try {
  if (profile) {
    writeFileSync(join(reports, "targets.json"), JSON.stringify([target]));
    const env = {
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
    runReportedTarget(run, target.id, join(workspace, target.path, "coverage"), (report) => {
      const env = {
        ...process.env,
        ...shared,
        ...targetEnvironment(target),
        WORKBENCH_PROJECT_ROOT: workspace,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_CI_DOCKER: adapter,
        RUNNER_TEMP: report
      };
      if (target.environment === "devcontainer")
        execute(process.execPath, [join(distribution, "bin/workbench.mjs"), "tools", "install", "--devcontainer"], env);
      for (const phase of targetPhases(target))
        execute(process.execPath, [join(distribution, "scripts/ci-run.mjs"), phase], env);
    });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImpvYi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGVycm9yRnJvbSB9IGZyb20gXCIuLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRhcmdldEVudmlyb25tZW50LCB0YXJnZXRQaGFzZXMgfSBmcm9tIFwiLi4vY2ktY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVSdW5SZXBvcnQsIHBhcnNlUnVuUmVwb3J0LCBydW5SZXBvcnRlZFRhcmdldCwgcnVuU3VjY2VlZGVkLCB3cml0ZVJ1blJlcG9ydCB9IGZyb20gXCIuLi9jaS1yZXN1bHRzLm1qc1wiO1xuaW1wb3J0IHsgcGFyc2VDSVdvcmtlclJlcXVlc3QgfSBmcm9tIFwiLi4vY2ktd29ya2VyLXJlcXVlc3QubWpzXCI7XG5cbi8vIFRoaXMgcHJpdmF0ZSByZXF1ZXN0IGlzIGNyZWF0ZWQgYnkgdGhlIGNvb3JkaW5hdG9yIGZyb20gaXRzIGZyb3plbiBzb3VyY2Ugc25hcHNob3QuXG5jb25zdCB7IHdvcmtzcGFjZSwgZGlzdHJpYnV0aW9uLCB0YXJnZXQsIHJlcG9ydHMsIGltYWdlLCBwcm9maWxlLCBjYWNoZSwgc2hhcmVkLCBhZGFwdGVyLCB1aWQsIGdpZCB9ID1cbiAgcGFyc2VDSVdvcmtlclJlcXVlc3QoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5hcmd2WzJdLCBcIk1pc3Npbmcgd29ya2VyIHJlcXVlc3QgcGF0aFwiKSwgXCJ1dGY4XCIpKSk7XG5mdW5jdGlvbiBleGVjdXRlKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIGVudiA9IHByb2Nlc3MuZW52KSB7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHsgY3dkOiB3b3Jrc3BhY2UsIGVudiwgc3RkaW86IFwiaW5oZXJpdFwiIH0pO1xuICBpZiAoY2hpbGQuZXJyb3IgfHwgY2hpbGQuc3RhdHVzICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyBjaGlsZC5zdGF0dXMpfWApO1xufVxuY29uc3QgcnVuID0gY3JlYXRlUnVuUmVwb3J0KFt0YXJnZXQuaWRdLCByZXBvcnRzKTtcbmNvbnN0IHJlc3VsdHMgPSBqb2luKHJlcG9ydHMsIFwiam9iLXJlc3VsdHMuanNvblwiKTtcbndyaXRlUnVuUmVwb3J0KHJlc3VsdHMsIHJ1bik7XG50cnkge1xuICBpZiAocHJvZmlsZSkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvcnRzLCBcInRhcmdldHMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoW3RhcmdldF0pKTtcbiAgICBjb25zdCBlbnYgPSB7XG4gICAgICBSVU5ORVJfVEVNUDogXCIvcmVwb3J0c1wiLFxuICAgICAgV09SS0JFTkNIX0NJX1RBUkdFVFM6IFwiL3JlcG9ydHMvdGFyZ2V0cy5qc29uXCIsXG4gICAgICBXT1JLQkVOQ0hfQ1BVX0JVREdFVDogc2hhcmVkLldPUktCRU5DSF9DUFVfQlVER0VULFxuICAgICAgLi4uKHNoYXJlZC5XT1JLQkVOQ0hfQ1BVUyA9PT0gdW5kZWZpbmVkID8ge30gOiB7IFdPUktCRU5DSF9DUFVTOiBzaGFyZWQuV09SS0JFTkNIX0NQVVMgfSksXG4gICAgfTtcbiAgICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGV4ZWN1dGUocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJjaS1pbWFnZS1leGVjXCIsXG4gICAgICAgIHByb2ZpbGUsXG4gICAgICAgIFwiLS1pbWFnZVwiLFxuICAgICAgICByZXF1aXJlZChpbWFnZSwgXCJNaXNzaW5nIHdvcmtlciBpbWFnZVwiKSxcbiAgICAgICAgXCItLXJlcG9ydHNcIixcbiAgICAgICAgcmVwb3J0cyxcbiAgICAgICAgXCItLWVudi1qc29uXCIsXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KGVudiksXG4gICAgICAgIFwiLS1cIixcbiAgICAgICAgXCJub2RlXCIsXG4gICAgICAgIFwie3dvcmtiZW5jaH0vc2NyaXB0cy9jaS1saW51eC9ydW4ubWpzXCIsXG4gICAgICBdKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZmFpbHVyZSA9IGVycm9yRnJvbShlcnJvcik7XG4gICAgfVxuICAgIGNvbnN0IHJldHVybmVkID0gcGFyc2VSdW5SZXBvcnQoXG4gICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJlcG9ydHMsIFwiZ3Vlc3QtcmVzdWx0cy5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgICAgW3RhcmdldC5pZF0sXG4gICAgICByZXBvcnRzLFxuICAgICk7XG4gICAgcnVuLnRhcmdldHMgPSByZXR1cm5lZC50YXJnZXRzO1xuICAgIHJ1bi5lcnJvcnMgPSByZXR1cm5lZC5lcnJvcnM7XG4gICAgaWYgKGZhaWx1cmUgJiYgcnVuU3VjY2VlZGVkKHJldHVybmVkKSkgdGhyb3cgZmFpbHVyZTtcbiAgfSBlbHNlIGlmICh0YXJnZXQua2luZCA9PT0gXCJlbnZpcm9ubWVudFwiKSB7XG4gICAgcnVuUmVwb3J0ZWRUYXJnZXQocnVuLCB0YXJnZXQuaWQsIGpvaW4od29ya3NwYWNlLCB0YXJnZXQucGF0aCwgXCJjb3ZlcmFnZVwiKSwgKHJlcG9ydCkgPT4ge1xuICAgICAgY29uc3QgZW52ID0ge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4uc2hhcmVkLFxuICAgICAgICAuLi50YXJnZXRFbnZpcm9ubWVudCh0YXJnZXQpLFxuICAgICAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiB3b3Jrc3BhY2UsXG4gICAgICAgIFdPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVDogZGlzdHJpYnV0aW9uLFxuICAgICAgICBXT1JLQkVOQ0hfQ0lfRE9DS0VSOiBhZGFwdGVyLFxuICAgICAgICBSVU5ORVJfVEVNUDogcmVwb3J0LFxuICAgICAgfTtcbiAgICAgIGlmICh0YXJnZXQuZW52aXJvbm1lbnQgPT09IFwiZGV2Y29udGFpbmVyXCIpXG4gICAgICAgIGV4ZWN1dGUocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tZGV2Y29udGFpbmVyXCJdLCBlbnYpO1xuICAgICAgZm9yIChjb25zdCBwaGFzZSBvZiB0YXJnZXRQaGFzZXModGFyZ2V0KSlcbiAgICAgICAgZXhlY3V0ZShwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9jaS1ydW4ubWpzXCIpLCBwaGFzZV0sIGVudik7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgbWtkaXJTeW5jKGpvaW4ocmVwb3J0cywgXCJob21lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwb3J0cywgXCJ0YXJnZXRzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KFt0YXJnZXRdKSk7XG4gICAgY29uc3QgZ3Vlc3REaXN0cmlidXRpb24gPSBgL3dvcmtzcGFjZS8ke3JlbGF0aXZlKHdvcmtzcGFjZSwgZGlzdHJpYnV0aW9uKX1gO1xuICAgIGxldCBjb250YWluZXJFcnJvcjogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGV4ZWN1dGUoXCJkb2NrZXJcIiwgW1xuICAgICAgICBcInJ1blwiLFxuICAgICAgICBcIi0tcm1cIixcbiAgICAgICAgXCItLWxhYmVsXCIsXG4gICAgICAgIGB3b3JrYmVuY2guY2kud29ya3NwYWNlPSR7d29ya3NwYWNlfWAsXG4gICAgICAgIFwiLS1uZXR3b3JrPWhvc3RcIixcbiAgICAgICAgXCItLWNhcC1kcm9wPUFMTFwiLFxuICAgICAgICBcIi0tc2VjdXJpdHktb3B0PW5vLW5ldy1wcml2aWxlZ2VzXCIsXG4gICAgICAgIFwiLS11c2VyXCIsXG4gICAgICAgIGAke1N0cmluZyh1aWQpfToke1N0cmluZyhnaWQpfWAsXG4gICAgICAgIFwiLS13b3JrZGlyXCIsXG4gICAgICAgIFwiL3dvcmtzcGFjZVwiLFxuICAgICAgICAuLi4oXG4gICAgICAgICAgW1xuICAgICAgICAgICAgW3dvcmtzcGFjZSwgXCIvd29ya3NwYWNlXCJdLFxuICAgICAgICAgICAgW2NhY2hlLCBjYWNoZV0sXG4gICAgICAgICAgICBbcmVwb3J0cywgXCIvcmVwb3J0c1wiXSxcbiAgICAgICAgICBdIGFzIGNvbnN0XG4gICAgICAgICkuZmxhdE1hcCgoW3NvdXJjZSwgZGVzdGluYXRpb25dKSA9PiB7XG4gICAgICAgICAgaWYgKHNvdXJjZS5pbmNsdWRlcyhcIixcIikpIHRocm93IG5ldyBFcnJvcihcIkRvY2tlciBiaW5kIG1vdW50cyBkbyBub3Qgc3VwcG9ydCBjb21tYXMgaW4gc291cmNlIHBhdGhzXCIpO1xuICAgICAgICAgIHJldHVybiBbXCItLW1vdW50XCIsIGB0eXBlPWJpbmQsc3JjPSR7c291cmNlfSxkc3Q9JHtkZXN0aW5hdGlvbn1gXTtcbiAgICAgICAgfSksXG4gICAgICAgIC4uLk9iamVjdC5lbnRyaWVzKHtcbiAgICAgICAgICAuLi5zaGFyZWQsXG4gICAgICAgICAgSE9NRTogXCIvcmVwb3J0cy9ob21lXCIsXG4gICAgICAgICAgUlVOTkVSX1RFTVA6IFwiL3JlcG9ydHNcIixcbiAgICAgICAgICBUTVBESVI6IFwiL3RtcFwiLFxuICAgICAgICAgIFdPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVDogZ3Vlc3REaXN0cmlidXRpb24sXG4gICAgICAgICAgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogXCIvd29ya3NwYWNlXCIsXG4gICAgICAgICAgV09SS0JFTkNIX0NJX1RBUkdFVFM6IFwiL3JlcG9ydHMvdGFyZ2V0cy5qc29uXCIsXG4gICAgICAgIH0pLmZsYXRNYXAoKFtrZXksIHZhbHVlXSkgPT4gW1wiLS1lbnZcIiwgYCR7a2V5fT0ke3ZhbHVlfWBdKSxcbiAgICAgICAgcmVxdWlyZWQoaW1hZ2UsIFwiTWlzc2luZyB3b3JrZXIgaW1hZ2VcIiksXG4gICAgICAgIFwibm9kZVwiLFxuICAgICAgICBgJHtndWVzdERpc3RyaWJ1dGlvbn0vc2NyaXB0cy9jaS1saW51eC9ydW4ubWpzYCxcbiAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb250YWluZXJFcnJvciA9IGVycm9yRnJvbShlcnJvcik7XG4gICAgfVxuICAgIGNvbnN0IHJldHVybmVkID0gcGFyc2VSdW5SZXBvcnQoXG4gICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJlcG9ydHMsIFwiZ3Vlc3QtcmVzdWx0cy5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgICAgW3RhcmdldC5pZF0sXG4gICAgICByZXBvcnRzLFxuICAgICk7XG4gICAgcnVuLnRhcmdldHMgPSByZXR1cm5lZC50YXJnZXRzO1xuICAgIHJ1bi5lcnJvcnMgPSByZXR1cm5lZC5lcnJvcnM7XG4gICAgaWYgKGNvbnRhaW5lckVycm9yICYmIChydW5TdWNjZWVkZWQocmV0dXJuZWQpIHx8IHJldHVybmVkLnRhcmdldHMuc29tZSgocmVzdWx0KSA9PiByZXN1bHQuZmluaXNoZWQgPT09IHVuZGVmaW5lZCkpKVxuICAgICAgdGhyb3cgY29udGFpbmVyRXJyb3I7XG4gIH1cbn0gY2F0Y2ggKGVycm9yKSB7XG4gIHJ1bi5lcnJvcnMucHVzaCh7XG4gICAgcGhhc2U6IFwidGFyZ2V0IGV4ZWN1dGlvbiBvciByZXN1bHRzXCIsXG4gICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuICB9KTtcbn0gZmluYWxseSB7XG4gIHdyaXRlUnVuUmVwb3J0KHJlc3VsdHMsIHJ1bik7XG59XG5pZiAoIXJ1blN1Y2NlZWRlZChydW4pKSBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxpQkFBaUI7QUFDcEMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxXQUFXLGNBQWMscUJBQXFCO0FBQ3ZELFNBQVMsTUFBTSxnQkFBZ0I7QUFDL0IsU0FBUyxtQkFBbUIsb0JBQW9CO0FBQ2hELFNBQVMsaUJBQWlCLGdCQUFnQixtQkFBbUIsY0FBYyxzQkFBc0I7QUFDakcsU0FBUyw0QkFBNEI7QUFHckMsTUFBTSxFQUFFLFdBQVcsY0FBYyxRQUFRLFNBQVMsT0FBTyxTQUFTLE9BQU8sUUFBUSxTQUFTLEtBQUssSUFBSSxJQUNqRyxxQkFBcUIsS0FBSyxNQUFNLGFBQWEsU0FBUyxRQUFRLEtBQUssQ0FBQyxHQUFHLDZCQUE2QixHQUFHLE1BQU0sQ0FBQyxDQUFDO0FBQ2pILFNBQVMsUUFBUSxTQUFpQixNQUF5QixNQUFNLFFBQVEsS0FBSztBQUM1RSxRQUFNLFFBQVEsVUFBVSxTQUFTLE1BQU0sRUFBRSxLQUFLLFdBQVcsS0FBSyxPQUFPLFVBQVUsQ0FBQztBQUNoRixNQUFJLE1BQU0sU0FBUyxNQUFNLFdBQVcsRUFBRyxPQUFNLElBQUksTUFBTSxHQUFHLE9BQU8sWUFBWSxPQUFPLE1BQU0sU0FBUyxNQUFNLE1BQU0sQ0FBQyxFQUFFO0FBQ3BIO0FBQ0EsTUFBTSxNQUFNLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLE9BQU87QUFDaEQsTUFBTSxVQUFVLEtBQUssU0FBUyxrQkFBa0I7QUFDaEQsZUFBZSxTQUFTLEdBQUc7QUFDM0IsSUFBSTtBQUNGLE1BQUksU0FBUztBQUNYLGtCQUFjLEtBQUssU0FBUyxjQUFjLEdBQUcsS0FBSyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDckUs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
