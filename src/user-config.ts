import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { editToml } from "./toml-edit.js";
import { readToml, readText, writeAtomic } from "./core.js";
import { userDirectory } from "./storage.js";
import { validateCollectionDirectories } from "./collection-schema.js";
import { withCacheLockSync } from "./cache-lock.js";

export const userOptions = {
  "terminal.plain": {
    type: "boolean",
    local: false,
    description: "Use stable plain text and line-oriented interactive prompts",
  },
  "execution.cpus_per_job": {
    type: "integer",
    local: true,
    description: "CPUs per job (default: automatic)",
  },
  "execution.max_jobs": {
    type: "integer",
    local: true,
    description: "Maximum concurrent jobs (default: CPU-derived)",
  },
  "skills.enabled": {
    type: "names",
    local: false,
    description: "Skills selected by this user; project applicability still applies",
  },
  "collections.directories": {
    type: "paths",
    local: true,
    description: "Additional local directories containing installed collections",
  },
  "storage.external": {
    type: "boolean",
    local: true,
    description: "Keep build products, prepared artifacts, and dependency installations outside checkouts",
  },
  "storage.root": {
    type: "path",
    local: true,
    description: "External storage root (default: platform Workbench cache)",
  },
} as const;
export const localUserOptionKeys = Object.entries(userOptions)
  .filter(([, option]) => option.local)
  .map(([key]) => key);
export type UserOption = keyof typeof userOptions;
export type UserValue = boolean | string | string[] | number;
type Values = Partial<Record<UserOption, UserValue>>;
const userSections = [...new Set(Object.keys(userOptions).map((key) => key.slice(0, key.indexOf("."))))];

/** Local parsing, editing, inspection, and completion share the same user-option scopes. */
export const localUserFields: Record<string, string[]> = Object.fromEntries(
  userSections.flatMap((section) => {
    const fields = localUserOptionKeys
      .filter((key) => key.startsWith(`${section}.`))
      .map((key) => key.slice(key.indexOf(".") + 1));
    return fields.length ? [[section, fields]] : [];
  }),
);

export const userConfigPath = (): string => join(userDirectory("config"), "config.toml");

export function validateUserOption(key: string, value: unknown): asserts key is UserOption {
  if (!Object.hasOwn(userOptions, key)) throw new Error(`unknown global option: ${key}`);
  if (key.startsWith("execution.")) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${key} requires a positive integer`);
    return;
  }
  if (key === "skills.enabled") {
    if (
      !Array.isArray(value) ||
      value.some((name: unknown) => typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ||
      new Set(value).size !== value.length
    )
      throw new Error("skills.enabled requires distinct skill names");
    return;
  }
  if (key === "collections.directories") {
    validateCollectionDirectories(value, key);
    return;
  }
  const boolean = userOptions[key as UserOption].type === "boolean";
  if (boolean ? typeof value !== "boolean" : typeof value !== "string" || !isAbsolute(value))
    throw new Error(`${key} requires ${boolean ? "true or false" : "an absolute path"}`);
}

export function readUserConfig(): Values {
  const path = userConfigPath();
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular global configuration file`);
  const document = readToml(path) as Record<string, unknown>;
  const values: Values = {};
  for (const [section, fields] of Object.entries(document)) {
    if (!userSections.includes(section) || !fields || typeof fields !== "object" || Array.isArray(fields))
      throw new Error(`${path}: unknown global section: ${section}`);
    for (const [field, value] of Object.entries(fields)) {
      const key = `${section}.${field}`;
      validateUserOption(key, value);
      values[key] = value as UserValue;
    }
  }
  return values;
}

export function userConfigValues(): Record<UserOption, UserValue | undefined> {
  return {
    "terminal.plain": false,
    "execution.cpus_per_job": undefined,
    "execution.max_jobs": undefined,
    "storage.external": false,
    "storage.root": userDirectory("cache"),
    "collections.directories": [],
    "skills.enabled": [],
    ...readUserConfig(),
  };
}

/** Serialize the whole read/modify/write, including updates made from different checkouts. */
export function updateUserOption(key: string, update: (current: UserValue | undefined) => UserValue | undefined): void {
  if (!Object.hasOwn(userOptions, key)) throw new Error(`unknown global option: ${key}`);
  withCacheLockSync(
    userConfigPath(),
    () => {
      const values = readUserConfig();
      const source = existsSync(userConfigPath()) ? readText(userConfigPath()) : "";
      const value = update(values[key as UserOption]);
      if (value === undefined) Reflect.deleteProperty(values, key);
      else {
        validateUserOption(key, value);
        values[key] = value;
      }
      writeAtomic(
        userConfigPath(),
        editToml(
          source,
          Object.fromEntries(
            userSections.map((section) => [
              section,
              Object.fromEntries(
                Object.entries(values)
                  .filter(([name]) => name.startsWith(`${section}.`))
                  .map(([name, value]) => [name.slice(section.length + 1), value]),
              ),
            ]),
          ),
        ),
      );
    },
    10000,
  );
}

export function setUserOption(key: string, text?: string): void {
  if (!Object.hasOwn(userOptions, key)) throw new Error(`unknown global option: ${key}`);
  if (text === undefined) {
    updateUserOption(key, () => undefined);
    return;
  }
  const type = userOptions[key as UserOption].type;
  const value: unknown =
    type === "names" || type === "paths"
      ? (JSON.parse(text) as unknown)
      : type === "integer"
        ? Number(text)
        : type === "boolean" && ["true", "false"].includes(text)
          ? text === "true"
          : text;
  validateUserOption(key, value);
  updateUserOption(key, () => value as UserValue);
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
