import { compilerCatalog, compilerFamilies, managedCompilerFamilies } from "../scripts/compiler-catalog.mjs";
import { InvalidInput } from "./input-errors.js";
import { validateProjectCollections } from "./collection-schema.js";
import { toolSpecification } from "./tool-pin.js";
import { relativePath } from "./paths.js";
import { readRegistryManagement } from "./registry-management-contract.js";
import { readCIDestinations } from "./ci-hosting.js";
import {
  validateDevelopmentProfiles,
  validateReleaseProfiles,
  validateProfileDefaults,
  validateToolProfiles,
  type DevelopmentProfile,
} from "./profile-schema.js";

type Validator = ((value: unknown, location: string) => void) & { choices?: string[] };

function fail(location: string, expected: string): never {
  throw new InvalidInput(`${location}: expected ${expected}`);
}

const text: Validator = (value, location) => {
  if (typeof value !== "string" || !value.trim()) fail(location, "a nonempty string");
};
export const projectNameField: Validator = (value, location) => {
  text(value, location);
  if (typeof value !== "string" || value !== value.trim() || value.length > 128 || /[\p{Cc}]/u.test(value))
    fail(location, "a display name of up to 128 characters without controls or surrounding whitespace");
};
const boolean: Validator = (value, location) => {
  if (typeof value !== "boolean") fail(location, "Boolean");
};
const positive: Validator = (value, location) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(location, "a positive number");
};
const integer: Validator = (value, location) => {
  positive(value, location);
  if (!Number.isSafeInteger(value)) fail(location, "a positive integer");
};
const mapping: Validator = (value, location) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) fail(location, "a table");
};
const array =
  (entry: Validator): Validator =>
  (value, location) => {
    if (!Array.isArray(value)) fail(location, "an array");
    value.forEach((item: unknown, index) => {
      entry(item, `${location}[${String(index)}]`);
    });
  };
const environmentNames: Validator = (value, location) => {
  array((entry, field) => {
    if (typeof entry !== "string" || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry))
      fail(field, "an exact environment variable name");
  })(value, location);
  const names = value as string[];
  if (new Set(names.map((name) => name.toUpperCase())).size !== names.length)
    fail(location, "environment names without case-insensitive duplicates");
};
const table =
  (fields: Record<string, Validator>): Validator =>
  (value, location) => {
    mapping(value, location);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "extensions") {
        mapping(entry, `${location}.extensions`);
        continue;
      }
      const validate = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!validate) throw new InvalidInput(`${location}: unknown field '${key}'`);
      validate(entry, `${location}.${key}`);
    }
  };

const choice = (...choices: string[]): Validator =>
  Object.assign(
    (value: unknown, location: string) => {
      if (typeof value !== "string" || !choices.includes(value)) fail(location, choices.join(" or "));
    },
    { choices },
  );

const selection =
  (choices: string[], nonempty = false): Validator =>
  (value, location) => {
    array(choice(...choices))(value, location);
    const values = value as string[];
    if (new Set(values).size !== values.length) fail(location, "a list without duplicates");
    if (nonempty && !values.length) fail(location, "at least one selection");
  };

const ref: Validator = (value, location) => {
  text(value, location);
  if ((value as string).startsWith("-")) fail(location, "a nonempty name that does not begin with '-'");
};

const toolchainSelection: Validator = (value, location) => {
  if (value !== false) text(value, location);
};

export const commitStyles = ["conventional", "plain", "area", "unrestricted"] as const;
export type CommitStyle = (typeof commitStyles)[number];
export const commitPrefixPattern = /^[A-Za-z0-9_.][A-Za-z0-9._/-]*$/;

const commitPrefixes: Validator = (value, location) => {
  array((entry, field) => {
    if (typeof entry !== "string" || !commitPrefixPattern.test(entry))
      fail(field, "a prefix containing letters, digits, dots, underscores, slashes, or hyphens");
  })(value, location);
  const prefixes = value as string[];
  if (!prefixes.length) fail(location, "at least one prefix");
  if (new Set(prefixes.map((prefix) => prefix.toLowerCase())).size !== prefixes.length)
    fail(location, "prefixes without case-insensitive duplicates");
};

/** Human-owned project options also drive config browsing, editing, and completion. */
export const projectFields: Record<string, Record<string, Validator>> = {
  collections: { sources: validateProjectCollections },
  tool: { repository: ref, revision: ref },
  markdown: { wrap_width: integer },
  compatibility: {
    required: Object.assign(boolean, { choices: ["true", "false"] }),
    data: choice("ask", "migrate", "delete"),
  },
  checks: {
    environment: choice("native", "guix", "nix", "nix-docker", "devcontainer"),
    nix_docker_image: (value, location) => {
      if (typeof value !== "string" || !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(value))
        fail(location, "image pinned by SHA-256 digest");
    },
    allow_empty: boolean,
    pass_environment: environmentNames,
    environment_files: array(text),
    inputs: array((value, location) => {
      text(value, location);
      relativePath(value as string, location);
      if ((value as string).split("/").includes(".git")) fail(location, "project files outside Git metadata");
    }),
  },
  ci: {
    registry_management: (value) => {
      readRegistryManagement(value);
    },
    destinations: (value) => {
      readCIDestinations(value);
    },
    cache: table({
      artifacts: (value, location) => {
        mapping(value, location);
        for (const [name, policy] of Object.entries(value as Record<string, unknown>)) {
          if (
            ![
              "llvm",
              "clang",
              "gcc",
              "rust",
              "java",
              "node",
              "go",
              "cmake",
              "ninja",
              "uv",
              "shfmt",
              "shellcheck",
              "actionlint",
              "cargo-nextest",
              "cargo-llvm-cov",
              "ruby",
              "php",
              "maven",
            ].includes(name)
          )
            fail(location, "a supported CI artifact retention group");
          choice("cache", "download")(policy, `${location}.${name}`);
        }
      },
    }),
    operating_systems: selection(["linux", "macos", "windows"], true),
    architectures: table({
      linux: selection(["x64", "arm64"], true),
      macos: selection(["arm64"], true),
      windows: selection(["x64"], true),
    }),
    environments: selection(["guix", "nix", "nix-docker", "devcontainer"]),
    toolchains: array(text),
    images: table({ native: text, nix: text, guix: text }),
  },
  review: { changes: boolean, tasks: boolean, task_approvals: boolean },
  commit: {
    style: choice(...commitStyles),
    prefixes: commitPrefixes,
    subject_width: integer,
    body_width: integer,
  },
  licenses: { allow: array(text) },
  bundle: { compression: choice("brotli", "zlib", "zstd") },
  development: { default: text, profiles: validateDevelopmentProfiles },
  toolchains: { profiles: validateToolProfiles },
  release: { profiles: validateReleaseProfiles },
  citations: {
    library_dir: (value, location) => {
      text(value, location);
      relativePath(value as string, location);
      if ((value as string).split("/").some((part) => part.startsWith("."))) fail(location, "a safe relative path");
    },
  },
};

export function projectField(key: string): Validator | undefined {
  const [section, field, extra] = key.split(".");
  if (!section || !field || extra || !Object.hasOwn(projectFields, section)) return undefined;
  const fields = projectFields[section];
  return fields && Object.hasOwn(fields, field) ? fields[field] : undefined;
}

export const projectOptionKeys = Object.entries(projectFields).flatMap(([section, fields]) =>
  Object.keys(fields).map((field) => `${section}.${field}`),
);

const commandFields = {
  name: text,
  role: text,
  command: array(text),
  stages: array(text),
  online: boolean,
  requires_setup: boolean,
  environment: text,
  warn_seconds: positive,
  ci: table({
    toolchain: toolchainSelection,
    operating_systems: array(text),
    environments: array(text),
    architectures: array(text),
  }),
  coverage: table({
    command: array(text),
    stages: array(text),
    operating_systems: array(text),
    environments: array(text),
    ci: table({
      operating_systems: array(text),
      environments: array(text),
      architectures: array(text),
      toolchain: toolchainSelection,
    }),
  }),
};

export const validateLanguageIndex = table({ schema_version: integer, languages: array(text) });
export const validateLanguageMetadata = table({
  schema_version: integer,
  id: text,
  name: text,
  summary: text,
  reference: text,
  manifests: array(text),
  starter: array(text),
  starter_assets: array(table({ path: text, source: text })),
  starter_root: (value, location) => {
    mapping(value, location);
    for (const key of Object.keys(value as object))
      if (!["standard", "compiler", "lto", "compilers"].includes(key))
        throw new InvalidInput(`${location}: unknown starter setting '${key}'`);
    validateRegistry({ language_root: [{ language: "starter", path: ".", ...(value as object) }] }, location);
  },
  pass_environment: environmentNames,
});
export const validateLanguageAutomation = table({ schema_version: integer, command: array(table(commandFields)) });

/** Shared structural boundary for every reader; role-specific constraints follow in their owners. */
const configTable = table({
  schema_version: integer,
  ...Object.fromEntries(Object.entries(projectFields).map(([section, fields]) => [section, table(fields)])),
  documentation: array(
    table({ project: text, source_map: text, source_paths: array(text), source_excludes: array(text) }),
  ),
  check_suite: array(table({ language: text, path: text })),
  check_order: array(table({ root: text, after: text, phase: choice("setup", "complete") })),
  check: array(table({ ...commandFields, project: text, path: text })),
});

export const validateConfig: Validator = (value, location) => {
  configTable(value, location);
  const tool = (value as { tool?: { repository: string; revision: string } }).tool;
  if (tool !== undefined) toolSpecification(tool);
  validateProfileDefaults(value as { development?: { default?: string; profiles?: DevelopmentProfile[] } });
};

export const validateRegistry = table({
  project: array(table({ id: text, name: projectNameField, path: text })),
  language_root: array(
    table({
      language: text,
      path: text,
      ci_environments: array(text),
      ci_versions: array(text),
      ci_platforms: selection(["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"], true),
      ci_compatibility: boolean,
      standard: text,
      compiler: choice(...compilerFamilies),
      managed_compilers: table({ guix: choice(...managedCompilerFamilies), nix: choice(...managedCompilerFamilies) }),
      lto: choice("off", "thin", "full"),
      compilers: table(
        Object.fromEntries(
          compilerFamilies.map((family) => [
            family,
            table({
              minimum: text,
              ci_versions: array(text),
              ci_architectures: selection(
                [
                  ...new Set(
                    compilerCatalog[family].platforms.map((platform) => platform.slice(platform.lastIndexOf("-") + 1)),
                  ),
                ],
                true,
              ),
            }),
          ]),
        ),
      ),
    }),
  ),
});

export const automationKeys = new Set(["check", "check_suite", "check_order", "documentation", "review", "extensions"]);
