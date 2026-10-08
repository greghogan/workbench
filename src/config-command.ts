import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { readConfig, readToml, writeAtomic } from "./core.js";
import { projectField, projectOptionKeys, validateConfig } from "./config-schema.js";
import { developmentEnvironment, ensureLocalIgnore, localConfiguration } from "./environments.js";
import { ownedPath } from "./paths.js";
import { setUserOption, userConfigPath, userConfigValues, userOptions, validateUserOption } from "./user-config.js";

export type ConfigScope = "global" | "project" | "local";
export const configScopes = ["global", "project", "local"];
const formatValue = (value: unknown): string =>
  value === undefined ? "<unset>" : typeof value === "string" ? value : JSON.stringify(value);

function scopeFor(key: string, requested?: ConfigScope): ConfigScope {
  const scope = requested ?? (Object.hasOwn(userOptions, key) ? "global" : "project");
  if (
    !(scope === "global"
      ? Object.hasOwn(userOptions, key)
      : scope === "local"
        ? key === "checks.environment" || Object.hasOwn(userOptions, key)
        : !!projectField(key))
  )
    throw new Error(`${key} is not an option in ${scope} scope`);
  return scope;
}

function localValues(root: string): Record<string, unknown> {
  const local = localConfiguration(root);
  return {
    "checks.environment": local.environment,
    "storage.external": local.storage?.external,
    "storage.root": local.storage?.root,
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
  const rows = [["SCOPE", "SECTION", "KEY", "VALUE"]];
  for (const current of scopes) {
    const values: Record<string, unknown> =
      current === "global" ? userConfigValues() : current === "project" ? projectValues(root) : localValues(root);
    if (key !== undefined) {
      console.log(formatValue(scope === undefined ? (localValues(root)[key] ?? values[key]) : values[key]));
      return;
    }
    for (const [name, value] of Object.entries(values)) {
      const [section = "", field = ""] = name.split(".");
      rows.push([current, section, field, formatValue(value)]);
    }
  }
  if (scopes.includes("global")) console.log(`Global: ${userConfigPath()}`);
  if (scopes.includes("project")) console.log(`Project: ${join(root, "workbench/config.toml")}`);
  if (scopes.includes("local")) console.log(`Local: ${join(root, "workbench/local.toml")}`);
  const widths = [0, 1, 2, 3].map((index) => Math.max(...rows.map((row) => row[index]?.length ?? 0)));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  console.log(`\n${border}`);
  for (const [index, row] of rows.entries()) {
    console.log(`| ${row.map((value, column) => value.padEnd(widths[column] ?? 0)).join(" | ")} |`);
    if (index === 0) console.log(border);
  }
  console.log(border);
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
  const document = (existsSync(path) ? readToml(path) : {}) as Record<string, unknown>;
  const [section = "", field = ""] = key.split(".");
  const fields = (document[section] ?? {}) as Record<string, unknown>;
  const validate =
    scope === "local"
      ? (value: unknown) => {
          if (key === "checks.environment") developmentEnvironment(value, key);
          else validateUserOption(key, value);
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
        throw error;
      }
      validate(value, key);
    }
    document[section] = { ...fields, [field]: value };
  }
  const updated = Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
  if (scope === "project") validateConfig(updated, path);
  const contents = stringify(updated);
  if (scope === "local") ensureLocalIgnore(root);
  writeAtomic(path, contents);
}
