import { projectPaths } from "../core/projects/project-paths.js";
import { releasePlan } from "../core/artifacts/release-profiles.js";
import { safeOutput } from "../core/diagnostics/terminal-output.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { hostOperatingSystem } from "../core/execution/checks/check-plan.js";
export function listReleaseProfiles(root: string, names?: string[], all = false, json = false): void {
  const profiles = releasePlan(root, names, all);
  if (json) console.log(JSON.stringify({ default: "all", profiles }, null, 2));
  else {
    console.log(`Host platform: ${hostOperatingSystem()}-${process.arch}`);
    console.log("Release preparation defaults to all configured profiles.");
    if (!profiles.length) console.log(`No release profiles configured in ${projectPaths.config}.`);
    for (const path of new Set(profiles.map((profile) => profile.path))) {
      console.log(`\n${safeOutput(path)}`);
      console.log(
        terminalTable(
          ["PROFILE", "BUILDER", "FORMAT", "TARGET"],
          profiles
            .filter((profile) => profile.path === path)
            .map((profile) => [profile.name, profile.builder, profile.format, profile.platform]),
        ),
      );
    }
  }
}
