import { LogLevel, LogFormat, LogCompressionPreference, hasEnumValue } from "../diagnostics/diagnostic-contract.mjs";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { editToml } from "./toml-edit.js";
import { readToml, readText } from "../runtime/files.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { userDirectory } from "../storage/storage.js";
import { validateCollectionDirectories } from "../collections/collection-schema.js";
import { PreparationStore } from "../execution/environments/managed/managed-contract.mjs";
import { withCacheLockSync } from "../storage/cache-lock.js";

export const userOptions = {
  "server.project_idle_seconds": {
    type: "integer",
    local: false,
    description: "Keep project monitoring after its last browser connection closes (default: 1800)",
  },
  "preparation.nix_store": {
    type: "preparation-store",
    local: false,
    description: "Store for local Nix image preparation: disabled, system, or managed (default: disabled)",
  },
  "preparation.guix_store": {
    type: "preparation-store",
    local: false,
    description: "Store for local Guix image preparation: disabled, system, or managed (default: disabled)",
  },
  "cache.auto_prune": {
    type: "boolean",
    local: false,
    description: "Prune superseded owned assets after successful replacement checks (default: true)",
  },
  "cache.max_generations": {
    type: "integer",
    local: false,
    description:
      "Retained build generations per root/environment/tool selection; zero disables count pruning (default: 2)",
  },
  "cache.max_image_generations": {
    type: "integer",
    local: false,
    description:
      "Retained verified prepared images per checkout/profile/platform; zero disables image pruning (default: 1)",
  },
  "cache.max_age_days": {
    type: "integer",
    local: false,
    description: "Superseded build generation age in days; zero disables age-off (default: 7)",
  },
  "cache.buildkit_max_bytes": {
    type: "integer",
    local: false,
    description: "Unused cache budget per owned BuildKit builder; zero disables size pruning (default: 10737418240)",
  },
  "cache.rust_max_bytes": {
    type: "integer",
    local: false,
    description: "Rust artifact budget per owned target directory; zero disables size pruning (default: 10000000000)",
  },
  "cache.rust_max_age_days": {
    type: "integer",
    local: false,
    description: "Idle Rust artifact and incremental-session age; zero disables age-off (default: 7)",
  },
  "diagnostics.level": { type: "level", local: false, description: "Diagnostic severity: debug, info, warn, or error" },
  "diagnostics.file_level": {
    type: "level",
    local: false,
    description: "Retained diagnostic severity (default: info)",
  },
  "diagnostics.server_level": {
    type: "level",
    local: false,
    description: "Server stderr severity (default: diagnostics.level)",
  },
  "diagnostics.server_file_level": {
    type: "level",
    local: false,
    description: "Server retained diagnostic severity (default: diagnostics.file_level)",
  },
  "diagnostics.format": { type: "format", local: false, description: "Diagnostic rendering: text or json" },
  "logs.check_max_age_days": {
    type: "integer",
    local: true,
    description: "Completed log retention age in days; zero disables age-off (default: 30)",
  },
  "logs.check_max_bytes": {
    type: "integer",
    local: true,
    description: "Stored log budget per checkout/root; zero disables size pruning (default: 1000000000)",
  },
  "logs.compression": {
    type: "log-compression",
    local: true,
    description: "Retained log codec: auto, zstd, gzip, or none (default: auto)",
  },
  "logs.cli_max_age_days": {
    type: "integer",
    local: false,
    description: "CLI diagnostic retention age; zero disables age-off (default: 30)",
  },
  "logs.cli_max_bytes": {
    type: "integer",
    local: false,
    description: "Stored CLI diagnostic budget; zero disables CLI diagnostic saving (default: 250000000)",
  },
  "logs.server_max_age_days": {
    type: "integer",
    local: false,
    description: "Closed server segment retention age; zero disables age-off (default: 30)",
  },
  "logs.server_max_bytes": {
    type: "integer",
    local: false,
    description: "Stored server diagnostic budget; zero disables size pruning (default: 1000000000)",
  },
  "logs.server_rotate_bytes": {
    type: "integer",
    local: false,
    description: "Uncompressed server segment size; zero disables size rotation (default: 100000000)",
  },
  "logs.server_rotate_hours": {
    type: "integer",
    local: false,
    description: "Server segment duration; zero disables time rotation (default: 24)",
  },
  "logs.prune_interval_seconds": {
    type: "integer",
    local: false,
    description: "Periodic diagnostic retention interval; zero disables sweeps (default: 3600)",
  },
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
  if (userOptions[key as UserOption].type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`${key} requires a nonnegative integer`);
    return;
  }
  if (userOptions[key as UserOption].type === "level" || key === "diagnostics.format") {
    const choices = key === "diagnostics.format" ? Object.values(LogFormat) : Object.values(LogLevel);
    if (!hasEnumValue(key === "diagnostics.format" ? LogFormat : LogLevel, value))
      throw new Error(`${key} requires ${choices.join(", ")}`);
    return;
  }
  if (key === "logs.compression") {
    if (!hasEnumValue(LogCompressionPreference, value)) throw new Error(`${key} requires auto, zstd, gzip, or none`);
    return;
  }
  if (userOptions[key as UserOption].type === "preparation-store") {
    if (!hasEnumValue(PreparationStore, value))
      throw new Error(`${key} requires ${Object.values(PreparationStore).join(", ")}`);
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

export function userConfigValues(preferences = readUserConfig()): Record<UserOption, UserValue | undefined> {
  return {
    "server.project_idle_seconds": 1800,
    "preparation.nix_store": PreparationStore.Disabled,
    "preparation.guix_store": PreparationStore.Disabled,
    "cache.auto_prune": true,
    "cache.max_generations": 2,
    "cache.max_image_generations": 1,
    "cache.max_age_days": 7,
    "cache.buildkit_max_bytes": 10 * 1024 ** 3,
    "cache.rust_max_bytes": 10_000_000_000,
    "cache.rust_max_age_days": 7,
    "diagnostics.level": LogLevel.Info,
    "diagnostics.file_level": LogLevel.Info,
    "diagnostics.server_level": undefined,
    "diagnostics.server_file_level": undefined,
    "diagnostics.format": LogFormat.Text,
    "logs.check_max_age_days": 30,
    "logs.check_max_bytes": 1000000000,
    "logs.compression": LogCompressionPreference.Auto,
    "logs.cli_max_age_days": 30,
    "logs.cli_max_bytes": 250000000,
    "logs.server_max_age_days": 30,
    "logs.server_max_bytes": 1000000000,
    "logs.server_rotate_bytes": 100000000,
    "logs.server_rotate_hours": 24,
    "logs.prune_interval_seconds": 3600,
    "terminal.plain": false,
    "execution.cpus_per_job": undefined,
    "execution.max_jobs": undefined,
    "storage.external": false,
    "storage.root": userDirectory("cache"),
    "collections.directories": [],
    "skills.enabled": [],
    ...preferences,
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
            userSections.map((section) => {
              const fields = Object.fromEntries(
                Object.entries(values)
                  .filter(([name]) => name.startsWith(`${section}.`))
                  .map(([name, value]) => [name.slice(section.length + 1), value]),
              );
              return [section, Object.keys(fields).length ? fields : undefined];
            }),
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
