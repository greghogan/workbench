import { projectPaths } from "../projects/project-paths.js";
import { readConfig } from "../projects/project-configuration.js";
import { readText } from "../runtime/files.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import {
  executionPreference,
  selectedDevelopmentProfile,
  withDevelopmentSelection,
  ensureLocalIgnore,
  localConfiguration,
} from "../execution/environments/environments.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { editToml } from "../configuration/toml-edit.js";

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

export function selectDevelopment(root: string, name: string, workspace?: string) {
  const profile = withDevelopmentSelection(
    root,
    undefined,
    name,
    () => selectedDevelopmentProfile(root, name),
    workspace,
  );
  if (!profile) throw new Error("a development profile name is required");
  const path = join(root, projectPaths.local);
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
  return profile;
}
