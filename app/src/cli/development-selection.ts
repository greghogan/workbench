import { projectPaths } from "../core/projects/project-paths.js";
import { createInterface } from "node:readline/promises";
import { inspectDevelopment, selectDevelopment } from "../core/artifacts/development.js";
import { plainOutput } from "../core/diagnostics/presentation.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { selectedDevelopmentProfile } from "../core/execution/environments/environments.js";

export function listDevelopment(root: string, json = false): void {
  const result = inspectDevelopment(root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Development selection: ${result.active ?? result.environment}`);
    console.log(
      terminalTable(
        ["ACTIVE", "PROFILE", "BUILDER", "WORKSPACE", "CONFIG"],
        result.profiles.map((profile) => [
          profile.active ? "*" : "",
          profile.name,
          profile.builder,
          profile.workspace,
          profile.container_config ?? "",
        ]),
      ),
    );
    if (!result.profiles.length)
      console.log(`No named profiles configured; use development.profiles in ${projectPaths.config}.`);
  }
}

export async function useDevelopment(root: string, requested?: string, workspace?: string): Promise<void> {
  let name = requested ?? (workspace ? selectedDevelopmentProfile(root)?.name : undefined);
  if (name === undefined) {
    listDevelopment(root);
    if (!process.stdin.isTTY)
      throw new Error("development use requires a profile name without an interactive terminal");
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
      ...(plainOutput() ? { terminal: false } : {}),
    });
    try {
      name = (await prompt.question("Profile name (Enter keeps the active selection): ")).trim();
    } finally {
      prompt.close();
    }
    if (!name) return;
  }
  const profile = selectDevelopment(root, name, workspace);
  console.log(
    `Selected development profile '${profile.name}' (${profile.builder}, ${profile.workspace}). Open a new workbench shell to use it.`,
  );
}
