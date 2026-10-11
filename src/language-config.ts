import { InvalidInput } from "./input-errors.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { distributionRoot, readToml, type CheckDefinition } from "./core.js";
import { validateLanguageIndex, validateLanguageMetadata, validateLanguageAutomation } from "./config-schema.js";
import { ownedPath, relativePath } from "./paths.js";
import { commandArguments, checkPolicy } from "./check-plan.js";
import { checkEnvironment } from "./environments.js";

export interface Language {
  id: string;
  name: string;
  summary: string;
  reference: string;
  manifests: string[];
  starter?: string[];
  command: (Omit<CheckDefinition, "name" | "project" | "path"> & { name?: string })[];
  directory: string;
  referenceRoot: string;
  source: "shared" | "local replacement" | "local addition";
}

const validId = /^[a-z][a-z0-9-]*$/;
function identity(id: string, context: string): void {
  if (!validId.test(id)) throw new InvalidInput(`${context}: invalid language identity '${id}'`);
}

/** Select the complete source before opening it; ignored shared definitions are never parsed. */
export function catalog(root: string): Language[] {
  const distribution = distributionRoot(root);
  const indexPath = ownedPath(distribution, "languages/index.toml");
  const localPath = ownedPath(root, "workbench/languages");
  const local = new Set<string>();
  if (existsSync(localPath)) {
    for (const entry of readdirSync(localPath, { withFileTypes: true })) {
      if (!entry.isDirectory())
        throw new InvalidInput(`${join(localPath, entry.name)}: expected a real language directory`);
      local.add(entry.name);
    }
  }
  return languageSources(readToml(indexPath), [...local], indexPath).map<Language>((selected) => {
    const { id, relative, source } = selected;
    const selectedRoot = source === "shared" ? distribution : root;
    const directory = ownedPath(selectedRoot, relative);
    const metadataPath = ownedPath(selectedRoot, `${relative}/config.toml`);
    const automationPath = ownedPath(selectedRoot, `${relative}/automation.toml`);
    const metadata = readToml(metadataPath) as Omit<Language, "command" | "directory" | "source" | "referenceRoot"> & {
      schema_version: number;
    };
    validateLanguageMetadata(metadata, metadataPath);
    if (
      metadata.schema_version !== 1 ||
      metadata.id !== id ||
      !metadata.name ||
      !metadata.summary ||
      !metadata.reference ||
      !Array.isArray(metadata.manifests) ||
      !metadata.manifests.length ||
      new Set(metadata.manifests).size !== metadata.manifests.length
    )
      throw new InvalidInput(`${metadataPath}: incomplete or inconsistent language metadata`);
    relativePath(metadata.reference, `${metadataPath}: reference`, true);
    ownedPath(selectedRoot, metadata.reference);
    for (const manifest of metadata.manifests) relativePath(manifest, `${metadataPath}: manifests`);
    if (metadata.starter) {
      if (!metadata.starter.length || new Set(metadata.starter).size !== metadata.starter.length)
        throw new InvalidInput(`${metadataPath}: starter must contain unique file paths`);
      for (const file of metadata.starter) {
        relativePath(file, `${metadataPath}: starter`);
        ownedPath(selectedRoot, metadata.reference === "." ? file : `${metadata.reference}/${file}`);
      }
    }
    const commands = languageAutomationFromData(readToml(automationPath), automationPath);
    return {
      ...metadata,
      command: commands,
      directory,
      referenceRoot: selectedRoot,
      source,
    };
  });
}

/** Resolve complete replacements before reading any ignored shared definition. */
export function languageSources(value: unknown, localIds: string[], context: string) {
  validateLanguageIndex(value, context);
  const index = value as { schema_version: number; languages: string[] };
  if (index.schema_version !== 1) throw new InvalidInput(`${context}: invalid catalog`);
  const shared = new Set<string>();
  for (const id of index.languages) {
    identity(id, context);
    if (shared.has(id)) throw new InvalidInput(`${context}: duplicate language '${id}'`);
    shared.add(id);
  }
  for (const id of localIds) identity(id, "workbench/languages");
  const local = new Set(localIds);
  return [...new Set([...shared, ...local])].map<{ id: string; relative: string; source: Language["source"] }>(
    (id) => ({
      id,
      relative: `${local.has(id) ? "workbench/languages" : "languages"}/${id}`,
      source: local.has(id) ? (shared.has(id) ? "local replacement" : "local addition") : "shared",
    }),
  );
}

export function languageAutomationFromData(value: unknown, automationPath: string): Language["command"] {
  validateLanguageAutomation(value, automationPath);
  const automation = value as { schema_version: number; command: Language["command"] };
  if (automation.schema_version !== 1 || !Array.isArray(automation.command) || !automation.command.length)
    throw new InvalidInput(`${automationPath}: expected a nonempty command definition`);
  const names = new Set<string>();
  for (const command of automation.command) {
    if (typeof command.role !== "string" || !/^[a-z][a-z0-9-]*$/.test(command.role))
      throw new InvalidInput(`${automationPath}: invalid command role`);
    const name = command.name ?? command.role;
    if (names.has(name)) throw new InvalidInput(`${automationPath}: duplicate command '${name}'`);
    names.add(name);
    commandArguments(command.command, automationPath);
    checkPolicy({ ...command, name });
    if (command.environment !== undefined) checkEnvironment(command.environment, automationPath);
  }
  return automation.command;
}
