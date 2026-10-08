import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stringify } from "smol-toml";
import { readToml, writeAtomic } from "./core.js";
import { userDirectory } from "./storage.js";

export const userOptions = {
  "storage.external": { type: "boolean", description: "Keep builds and dependency installations outside checkouts" },
  "storage.root": { type: "path", description: "External storage root (default: platform Workbench cache)" },
} as const;
export type UserOption = keyof typeof userOptions;
type Values = Partial<Record<UserOption, boolean | string>>;

export const userConfigPath = (): string => join(userDirectory("config"), "config.toml");

export function validateUserOption(key: string, value: unknown): asserts key is UserOption {
  if (!Object.hasOwn(userOptions, key)) throw new Error(`unknown global option: ${key}`);
  if (key === "storage.external" ? typeof value !== "boolean" : typeof value !== "string" || !isAbsolute(value))
    throw new Error(`${key} requires ${key === "storage.external" ? "true or false" : "an absolute path"}`);
}

export function readUserConfig(): Values {
  const path = userConfigPath();
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular global configuration file`);
  const document = readToml(path) as Record<string, unknown>;
  const values: Values = {};
  for (const [section, fields] of Object.entries(document)) {
    if (section !== "storage" || !fields || typeof fields !== "object" || Array.isArray(fields))
      throw new Error(`${path}: unknown global section: ${section}`);
    for (const [field, value] of Object.entries(fields)) {
      const key = `${section}.${field}`;
      validateUserOption(key, value);
      values[key] = value as boolean | string;
    }
  }
  return values;
}

export function userConfigValues(): Record<UserOption, boolean | string> {
  return { "storage.external": false, "storage.root": userDirectory("cache"), ...readUserConfig() };
}

export function setUserOption(key: string, text?: string): void {
  if (!Object.hasOwn(userOptions, key)) throw new Error(`unknown global option: ${key}`);
  let values = readUserConfig();
  if (text === undefined) values = Object.fromEntries(Object.entries(values).filter(([name]) => name !== key));
  else {
    const value = key === "storage.external" ? (text === "true" ? true : text === "false" ? false : text) : text;
    validateUserOption(key, value);
    values[key] = value;
  }
  writeAtomic(
    userConfigPath(),
    stringify({
      storage: Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name.slice("storage.".length), value]),
      ),
    }),
  );
}

/** Environment sessions carry the host's resolved preference through containers. */
export function storageSettings(local: { external?: boolean; root?: string } = {}): {
  external: boolean;
  root: string;
} {
  const values = userConfigValues();
  const external = process.env.WORKBENCH_STORAGE_EXTERNAL;
  const root = process.env.WORKBENCH_STORAGE_ROOT ?? local.root ?? (values["storage.root"] as string);
  if (external !== undefined && external !== "true" && external !== "false")
    throw new Error("invalid inherited Workbench storage selection");
  if (!isAbsolute(root)) throw new Error("Workbench storage root must be absolute");
  return {
    external:
      external === undefined ? (local.external ?? (values["storage.external"] as boolean)) : external === "true",
    root,
  };
}
