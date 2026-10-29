import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { projectField, projectOptionKeys, validateConfig } from "./config-schema.js";
import { readConfig } from "./project-configuration.js";
import { readText } from "./files.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import {
  developmentEnvironment,
  ensureLocalIgnore,
  localConfiguration,
  selectedDevelopmentProfile,
} from "./environments.js";
import { ownedPath } from "./paths.js";
import { plainOutput } from "./presentation.js";
import { terminalTable } from "./terminal-table.js";
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
const formatValue = (value: unknown): string =>
  value === undefined ? "<unset>" : typeof value === "string" ? value : JSON.stringify(value);

/** Wrap complete values only to fit the remaining table column. */
function overviewValue(value: unknown, width: number): string[] {
  const text = formatValue(value).replace(/\p{Cc}/gu, " ");
  if (plainOutput()) return [text];
  const characters = Array.from(text);
  const lines: string[] = [];
  for (let start = 0; start < characters.length; start += width)
    lines.push(characters.slice(start, start + width).join(""));
  return lines.length ? lines : [""];
}

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
      return [
        key,
        (config[section] as Record<string, unknown> | undefined)?.[field] ??
          (key === "bundle.compression" ? "brotli" : undefined),
      ];
    }),
  );
}

export function showConfiguration(root: string, scope?: ConfigScope, key?: string): void {
  const selected = key === undefined ? scope : scopeFor(key, scope);
  const scopes: ConfigScope[] = selected
    ? [selected]
    : ["global", ...(existsSync(join(root, "workbench/config.toml")) ? (["project", "local"] as const) : [])];
  const values = new Map<string, { value: unknown; scope: string }>();
  const sources: string[] = [];
  const explicitGlobal = scopes.includes("global") ? readUserConfig() : {};
  for (const current of scopes) {
    const layer: Record<string, unknown> =
      current === "global" ? userConfigValues() : current === "project" ? projectValues(root) : localValues(root);
    if (key !== undefined) {
      console.log(formatValue(scope === undefined ? (localValues(root)[key] ?? layer[key]) : layer[key]));
      return;
    }
    const path =
      current === "global"
        ? userConfigPath()
        : join(root, `workbench/${current === "project" ? "config" : "local"}.toml`);
    const raw = existsSync(path) && current === "project" ? (parse(readText(path)) as Record<string, unknown>) : {};
    for (const [name, value] of Object.entries(layer)) {
      if (value === undefined && values.has(name)) continue;
      const [section = "", field = ""] = name.split(".");
      const configured =
        current === "global"
          ? Object.hasOwn(explicitGlobal, name)
          : current === "local"
            ? value !== undefined
            : Object.hasOwn((raw[section] as Record<string, unknown> | undefined) ?? {}, field);
      values.set(name, { value, scope: configured ? current : "default" });
    }
    sources.push(`${current}: ${path}${existsSync(path) ? "" : " (not created)"}`);
  }
  const nameWidth = Math.max("OPTION".length, ...[...values.keys()].map((name) => name.length));
  const scopeWidth = Math.max("SCOPE".length, ...[...values.values()].map((entry) => entry.scope.length));
  const columns = process.stdout.columns || 80;
  const valueWidth = Math.max("VALUE".length, columns - nameWidth - scopeWidth - 10);
  const rows = [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, entry]) =>
      overviewValue(entry.value, valueWidth).map((line, index) => [index ? "" : name, line, index ? "" : entry.scope]),
    );
  console.log(terminalTable(["OPTION", "VALUE", "SCOPE"], rows));
  console.log("\n" + sources.join("\n"));
  console.log("\nRaw value: workbench config get <option> [--scope global|project|local]");
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
