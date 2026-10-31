import { toolProfiles } from "./tool-profiles.js";
import { terminalTable } from "./terminal-table.js";

export function listToolProfiles(root: string, json = false): void {
  const profiles = toolProfiles(root);
  if (json) console.log(JSON.stringify(profiles, null, 2));
  else
    console.log(
      terminalTable(
        ["PROFILE", "ROOTS", "COMPILER", "TOOLS", "PLATFORMS"],
        profiles.map((profile) => [
          profile.name,
          profile.paths.join(", "),
          profile.compiler ?? "pins",
          Object.entries(profile.tools ?? {})
            .map(([name, version]) => `${name} ${version}`)
            .join(", ") || "pins",
          profile.platforms?.join(", ") ?? "configured platforms",
        ]),
      ),
    );
}
