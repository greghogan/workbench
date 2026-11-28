import { projectPaths } from "../projects/project-paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { projectField, projectOptionDefaults, projectOptionKeys, validateConfig } from "./config-schema.js";
import { readConfig } from "../projects/project-configuration.js";
import { readText } from "../runtime/files.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import {
  developmentEnvironment,
  ensureLocalIgnore,
  localConfiguration,
  selectedDevelopmentProfile,
} from "../execution/environments/environments.js";
import { ownedPath } from "../runtime/paths.js";
import { editToml } from "./toml-edit.js";
import {
  localUserOptionKeys,
  readUserConfig,
  setUserOption,
  userConfigPath,
  userConfigValues,
  userOptions,
  validateUserOption,
} from "./user-config.js";

export type ConfigScope = "global" | "project" | "local";
export const configScopes = ["global", "project", "local"];
export type ConfigurationInspection =
  | { kind: "value"; value: unknown }
  | { kind: "table"; values: Map<string, { value: unknown; scope: string; behavior?: string }>; sources: string[] };

function scopeFor(key: string, requested?: ConfigScope): ConfigScope {
  const scope =
    requested ??
    (["development.profile", "development.workspace"].includes(key)
      ? "local"
      : Object.hasOwn(userOptions, key)
        ? "global"
        : "project");
  if (
    !(scope === "global"
      ? Object.hasOwn(userOptions, key)
      : scope === "local"
        ? ["checks.environment", "development.profile", "development.workspace", ...localUserOptionKeys].includes(key)
        : !!projectField(key))
  )
    throw new Error(`${key} is not an option in ${scope} scope`);
  return scope;
}

function localValues(root: string): Record<string, unknown> {
  const local = localConfiguration(root);
  return {
    "checks.environment": local.environment,
    "development.profile": local.profile,
    "development.workspace": local.workspace,
    ...Object.fromEntries(
      localUserOptionKeys.map((key) => {
        const [section = "", field = ""] = key.split(".");
        return [key, ((local as Record<string, unknown>)[section] as Record<string, unknown> | undefined)?.[field]];
      }),
    ),
  };
}

function projectValues(root: string): Record<string, unknown> {
  const config = readConfig(root);
  return Object.fromEntries(
    projectOptionKeys.map((key) => {
      const [section = "", field = ""] = key.split(".");
      const fallback = projectOptionDefaults[key];
      return [
        key,
        (config[section] as Record<string, unknown> | undefined)?.[field] ??
          ("value" in fallback ? fallback.value : undefined),
      ];
    }),
  );
}

function missingBehavior(scope: ConfigScope, key: string): string {
  if (scope === "local") return "Inherit";
  if (scope === "project") {
    const fallback = projectOptionDefaults[key as keyof typeof projectOptionDefaults];
    if ("behavior" in fallback) return fallback.behavior;
  }
  return "Automatic";
}

export function inspectConfiguration(root: string, scope?: ConfigScope, key?: string): ConfigurationInspection {
  const selected = key === undefined ? scope : scopeFor(key, scope);
  const scopes: ConfigScope[] = selected
    ? [selected]
    : ["global", ...(existsSync(join(root, projectPaths.config)) ? (["project", "local"] as const) : [])];
  const values = new Map<string, { value: unknown; scope: string; behavior?: string }>();
  const sources: string[] = [];
  const explicitGlobal = scopes.includes("global") ? readUserConfig() : {};
  for (const current of scopes) {
    const layer: Record<string, unknown> =
      current === "global"
        ? userConfigValues(explicitGlobal)
        : current === "project"
          ? projectValues(root)
          : localValues(root);
    if (current === "global") {
      layer["diagnostics.server_level"] ??= layer["diagnostics.level"];
      layer["diagnostics.server_file_level"] ??= layer["diagnostics.file_level"];
    }
    if (key !== undefined) {
      return { kind: "value", value: scope === undefined ? (localValues(root)[key] ?? layer[key]) : layer[key] };
    }
    const path =
      current === "global"
        ? userConfigPath()
        : join(root, `workbench/${current === "project" ? "config" : "local"}.toml`);
    const automation = join(root, projectPaths.automation);
    const raw =
      current === "project"
        ? { ...parse(readText(path)), ...(existsSync(automation) ? parse(readText(automation)) : {}) }
        : {};
    for (const [name, value] of Object.entries(layer)) {
      if (value === undefined && values.has(name)) continue;
      const [section = "", field = ""] = name.split(".");
      const configured =
        current === "global"
          ? Object.hasOwn(explicitGlobal, name)
          : current === "local"
            ? value !== undefined
            : Object.hasOwn((raw[section] as Record<string, unknown> | undefined) ?? {}, field);
      values.set(name, {
        value,
        scope: configured ? current : "default",
        ...(value === undefined ? { behavior: missingBehavior(current, name) } : {}),
      });
    }
    sources.push(`${current}: ${path}${existsSync(path) ? "" : " (not created)"}`);
  }
  return { kind: "table", values, sources };
}

export function setConfiguration(root: string, key: string, text?: string, requested?: ConfigScope): void {
  const scope = scopeFor(key, requested);
  if (scope === "global") {
    setUserOption(key, text);
    return;
  }
  if (scope === "project") readConfig(root);
  else {
    readConfig(root);
    localConfiguration(root);
  }
  const path = ownedPath(root, `workbench/${scope === "project" ? "config" : "local"}.toml`);
  const source = existsSync(path) ? readText(path) : "";
  const document = parse(source) as Record<string, unknown>;
  const [section = "", field = ""] = key.split(".");
  const fields = (document[section] ?? {}) as Record<string, unknown>;
  const validate =
    scope === "local"
      ? (value: unknown) => {
          if (key === "checks.environment") developmentEnvironment(value, key);
          else if (key === "development.profile") {
            if (typeof value !== "string") throw new Error("development.profile must be a profile name");
            selectedDevelopmentProfile(root, value);
          } else if (key === "development.workspace") {
            if (value !== "host" && value !== "devcontainer") throw new Error("workspace must be host or devcontainer");
          } else validateUserOption(key, value);
        }
      : projectField(key);
  if (!validate) throw new Error(`unknown option: ${key}`);
  if (text === undefined) {
    if (scope === "project" && ["markdown.wrap_width", "compatibility.required"].includes(key))
      throw new Error(`${key} is required; set its value explicitly`);
    document[section] = Object.fromEntries(Object.entries(fields).filter(([name]) => name !== field));
    if (!Object.keys(document[section] as object).length) document[section] = undefined;
  } else {
    let value: unknown = text;
    try {
      validate(value, key);
    } catch (error) {
      try {
        value = parse(`value = ${text}`).value;
      } catch {
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw error;
        }
      }
      validate(value, key);
    }
    document[section] = { ...fields, [field]: value };
  }
  const updated = Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
  if (scope === "local" && text !== undefined && ["checks.environment", "development.profile"].includes(key)) {
    const opposite = key === "checks.environment" ? "development" : "checks";
    Reflect.deleteProperty(updated, opposite);
  }
  if (scope === "project") validateConfig(updated, path);
  const contents = editToml(source, updated);
  if (scope === "local") ensureLocalIgnore(root);
  writeAtomic(path, contents);
}
