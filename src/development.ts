import { createInterface } from "node:readline/promises";
import { readConfig } from "./core.js";
import { executionPreference, selectedDevelopmentProfile } from "./environments.js";
import { setConfiguration } from "./config-command.js";
import { terminalTable } from "./terminal-table.js";

export function inspectDevelopment(root: string) {
  const selected = selectedDevelopmentProfile(root);
  return {
    active: selected?.name ?? null,
    environment: executionPreference(root) ?? readConfig(root).checks?.environment ?? "native",
    profiles: (readConfig(root).development?.profiles ?? []).map((profile) => ({
      ...profile,
      active: profile.name === selected?.name,
    })),
  };
}

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
      console.log("No named profiles configured; use development.profiles in workbench/config.toml.");
  }
}

export async function useDevelopment(root: string, requested?: string): Promise<void> {
  let name = requested;
  if (name === undefined) {
    listDevelopment(root);
    if (!process.stdin.isTTY)
      throw new Error("development use requires a profile name without an interactive terminal");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      name = (await prompt.question("Profile name (Enter keeps the active selection): ")).trim();
    } finally {
      prompt.close();
    }
    if (!name) return;
  }
  const profile = selectedDevelopmentProfile(root, name);
  if (!profile) throw new Error("a development profile name is required");
  setConfiguration(root, "development.profile", profile.name, "local");
  console.log(
    `Selected development profile '${profile.name}' (${profile.builder}, ${profile.workspace}). Open a new workbench shell to use it.`,
  );
}
