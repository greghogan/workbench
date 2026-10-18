import { createInterface } from "node:readline/promises";
import { plainOutput } from "./presentation.js";
import { readConfig, readText, writeAtomic } from "./core.js";
import {
  executionPreference,
  selectedDevelopmentProfile,
  withDevelopmentSelection,
  ensureLocalIgnore,
  localConfiguration,
} from "./environments.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { terminalTable } from "./terminal-table.js";

export function inspectDevelopment(root: string) {
  const selected = selectedDevelopmentProfile(root);
  return {
    active: selected?.name ?? null,
    environment: executionPreference(root) ?? readConfig(root).checks?.environment ?? "native",
    profiles: (readConfig(root).development?.profiles ?? []).map((profile) => ({
      ...profile,
      workspace:
        profile.name === selected?.name
          ? selected.workspace
          : (localConfiguration(root).workspace ?? profile.workspace),
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
  const profile = withDevelopmentSelection(
    root,
    undefined,
    name,
    () => selectedDevelopmentProfile(root, name),
    workspace,
  );
  if (!profile) throw new Error("a development profile name is required");
  const path = join(root, "workbench/local.toml");
  const source = existsSync(path) ? readText(path) : "";
  const document = parse(source) as Record<string, Record<string, unknown>>;
  if (document.checks) {
    delete document.checks.environment;
    if (!Object.keys(document.checks).length) delete document.checks;
  }
  document.development = {
    ...document.development,
    profile: profile.name,
    ...(workspace ? { workspace: profile.workspace } : {}),
  };
  ensureLocalIgnore(root);
  writeAtomic(path, editToml(source, document));
  console.log(
    `Selected development profile '${profile.name}' (${profile.builder}, ${profile.workspace}). Open a new workbench shell to use it.`,
  );
}
