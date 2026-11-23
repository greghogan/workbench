import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectPaths } from "../projects/project-paths.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { readConfigurationToml } from "../configuration/configuration-snapshot.js";
import { record, string, strings } from "../runtime/values.mjs";
import { ownedPath, relativePath } from "../runtime/paths.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { imageRepository } from "./container-references.js";
import { required } from "../runtime/invariants.js";

export const artifactKinds = ["toolchain", "development", "release"] as const;
export const artifactFormats = ["archive", "oci", "nix-export", "guix-export", "squashfs", "dmg", "apptainer"] as const;
export const artifactPlatforms = ["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"] as const;
type ArtifactKind = (typeof artifactKinds)[number];
type ArtifactFormat = (typeof artifactFormats)[number];
type ArtifactPlatform = (typeof artifactPlatforms)[number];
type Builder = "native" | "nix" | "guix";

export interface FileArtifactRecipe {
  owner: string;
  inputs: string[];
  build: string[];
  verify: string[];
  verifyInputs?: string[];
  package?: { file?: string };
}

interface ImageArtifactRecipe {
  owner: string;
  offlineProfile: string;
}

export interface StoreArtifactRecipe {
  owner: string;
  storeProfile: string;
  bootstrapImage?: string;
  verify: string[];
}

export interface NativeArchiveRecipe {
  owner: string;
  nativeProfile: string;
  bootstrapImage: string;
}

export type ArtifactRecipe = FileArtifactRecipe | ImageArtifactRecipe | StoreArtifactRecipe | NativeArchiveRecipe;

function usesReleaseTag(recipe: ArtifactRecipe): boolean {
  return "build" in recipe && [...recipe.build, ...recipe.verify].some((argument) => argument.includes("{tag}"));
}

export interface ArtifactTarget {
  platform: ArtifactPlatform;
  abi?: string;
  cpu?: string;
  runtime?: string;
}

export interface ArtifactVariant {
  target: string;
  kind: ArtifactKind;
  formats: ArtifactFormat[];
  recipe: string;
  ci_skip_reason?: string;
}

export interface ArtifactProfile {
  builder: Builder;
  projects: string[];
  workspace: "host" | "devcontainer";
  variants: ArtifactVariant[];
}

export type ArtifactDestination =
  | { kind: "registry"; repository: string }
  | { kind: "github"; repository: string }
  | { kind: "gitlab"; host: string; project: string };

export interface ArtifactPublicationRule {
  refs: string[];
  profiles: string[];
  targets: { name: string; platform: ArtifactPlatform }[];
  kind: ArtifactKind;
  destination: string;
}

interface ArtifactCatalog {
  targets: Record<string, ArtifactTarget>;
  profiles: Record<string, ArtifactProfile>;
  recipes: Record<string, ArtifactRecipe>;
  destinations: Record<string, ArtifactDestination>;
  publication: { branch?: ArtifactPublicationRule; tag?: ArtifactPublicationRule };
}

function fields(input: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  const data = record(input, `${context}: expected a table`);
  for (const key of Object.keys(data))
    if (!allowed.includes(key)) throw new InvalidInput(`${context}: unknown field '${key}'`);
  return data;
}

function choices<T extends string>(input: unknown, allowed: readonly T[], context: string): T {
  const choice = allowed.find((entry) => entry === input);
  if (choice === undefined) throw new InvalidInput(`${context}: expected ${allowed.join(", ")}`);
  return choice;
}

function items(input: unknown, context: string, distinct = true): string[] {
  const values = strings(input, `${context}: expected an array of strings`);
  if (
    !values.length ||
    values.some((item) => !item.trim() || item.includes("\0")) ||
    (distinct && new Set(values).size !== values.length)
  )
    throw new InvalidInput(`${context}: expected nonempty${distinct ? ", distinct" : ""} strings`);
  return values;
}

function names<T>(input: unknown, context: string, decode: (data: unknown, key: string) => T): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record(input, `${context}: expected named tables`)).map(([name, data]) => {
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new InvalidInput(`${context}: invalid name '${name}'`);
      return [name, decode(data, name)];
    }),
  );
}

function optionalText(input: unknown, context: string) {
  if (input === undefined) return {};
  return { [context]: items([input], context)[0] };
}

function supportedFormat(format: ArtifactFormat, target: ArtifactTarget, builder: Builder): boolean {
  if (format === "nix-export" && builder !== "nix") return false;
  if (format === "guix-export" && builder !== "guix") return false;
  if (format === "dmg") return target.platform === "macos-arm64";
  return format === "archive" || target.platform.startsWith("linux-");
}

function bootstrapReference(input: unknown, name: string): string {
  const bootstrapImage = string(input, `${name}.bootstrap_image: expected a pinned image`);
  const [reference, digest] = bootstrapImage.split("@");
  if (
    !/^sha256:[a-f0-9]{64}$/.test(bootstrapImage) &&
    !(
      reference &&
      imageRepository(reference) &&
      digest &&
      /^sha256:[a-f0-9]{64}$/.test(digest) &&
      `${reference}@${digest}` === bootstrapImage
    )
  )
    throw new InvalidInput(`${name}: pin the bootstrap image by its SHA-256 digest`);
  return bootstrapImage;
}

export function decodeArtifactCatalog(input: unknown, registered: ReadonlySet<string>): ArtifactCatalog {
  const data = fields(
    input,
    ["schema_version", "targets", "profiles", "recipes", "destinations", "publication", "development", "release"],
    "Artifact catalog",
  );
  if (data.schema_version !== 1) throw new InvalidInput("Artifact catalog: schema_version must be 1");
  const targets = names(data.targets ?? {}, "targets", (raw, name): ArtifactTarget => {
    const target = fields(raw, ["platform", "abi", "cpu", "runtime"], `target ${name}`);
    return {
      platform: choices(target.platform, artifactPlatforms, `${name}.platform`),
      ...optionalText(target.abi, "abi"),
      ...optionalText(target.cpu, "cpu"),
      ...optionalText(target.runtime, "runtime"),
    };
  });
  const recipes = names(data.recipes ?? {}, "recipes", (raw, name): ArtifactRecipe => {
    const recipe = fields(
      raw,
      [
        "owner",
        "inputs",
        "build",
        "verify",
        "verify_inputs",
        "package",
        "offline_profile",
        "store_profile",
        "native_profile",
        "bootstrap_image",
      ],
      `recipe ${name}`,
    );
    const owner = string(recipe.owner, `${name}.owner: expected a registered project`);
    if (!registered.has(owner)) throw new InvalidInput(`${name}: unknown project '${owner}'`);
    if (recipe.native_profile !== undefined) {
      if (
        ["inputs", "build", "verify", "verify_inputs", "package", "offline_profile", "store_profile"].some(
          (key) => recipe[key] !== undefined,
        )
      )
        throw new InvalidInput(`${name}: the native preparation profile owns its inputs and commands`);
      const nativeProfile = string(recipe.native_profile, `${name}.native_profile: expected a profile name`);
      if (!/^[a-z][a-z0-9_-]*$/.test(nativeProfile)) throw new InvalidInput(`${name}: invalid native profile name`);
      return { owner, nativeProfile, bootstrapImage: bootstrapReference(recipe.bootstrap_image, name) };
    }
    if (recipe.offline_profile !== undefined) {
      if (
        recipe.inputs !== undefined ||
        recipe.build !== undefined ||
        recipe.verify !== undefined ||
        recipe.verify_inputs !== undefined ||
        recipe.package !== undefined ||
        recipe.store_profile !== undefined ||
        recipe.bootstrap_image !== undefined
      )
        throw new InvalidInput(`${name}: the offline image profile owns its inputs and commands`);
      const offlineProfile = string(recipe.offline_profile, `${name}.offline_profile: expected a profile name`);
      if (!/^[a-z][a-z0-9_-]*$/.test(offlineProfile)) throw new InvalidInput(`${name}: invalid image profile name`);
      return { owner, offlineProfile };
    }
    if (recipe.store_profile !== undefined) {
      if (
        recipe.inputs !== undefined ||
        recipe.build !== undefined ||
        recipe.verify_inputs !== undefined ||
        recipe.package !== undefined
      )
        throw new InvalidInput(`${name}: the selected store profile owns its inputs and preparation`);
      const storeProfile = string(recipe.store_profile, `${name}.store_profile: expected a profile name`);
      if (!/^[a-z][a-z0-9_-]*$/.test(storeProfile)) throw new InvalidInput(`${name}: invalid store profile name`);
      if (recipe.bootstrap_image === undefined)
        return { owner, storeProfile, verify: items(recipe.verify, `${name}.verify`, false) };
      if (recipe.verify !== undefined)
        throw new InvalidInput(`${name}: put the offline verification command in the selected preparation profile`);
      return { owner, storeProfile, bootstrapImage: bootstrapReference(recipe.bootstrap_image, name), verify: [] };
    }
    if (recipe.bootstrap_image !== undefined)
      throw new InvalidInput(`${name}: bootstrap_image requires a native or managed store profile`);
    const inputs = items(recipe.inputs, `${name}.inputs`);
    for (const path of inputs) relativePath(path, `${name}.inputs`);
    const verifyInputs =
      recipe.verify_inputs === undefined ? undefined : items(recipe.verify_inputs, `${name}.verify_inputs`);
    for (const path of verifyInputs ?? []) relativePath(path, `${name}.verify_inputs`);
    const packaging = recipe.package === undefined ? undefined : fields(recipe.package, ["file"], `${name}.package`);
    const file = packaging?.file === undefined ? undefined : string(packaging.file, `${name}.package.file`);
    if (file !== undefined) {
      relativePath(file, `${name}.package.file`);
      if (file.includes("/")) throw new InvalidInput(`${name}: package.file must name one output file`);
    }
    return {
      owner,
      inputs,
      build: items(recipe.build, `${name}.build`, false),
      verify: items(recipe.verify, `${name}.verify`, false),
      ...(verifyInputs ? { verifyInputs } : {}),
      ...(packaging ? { package: file === undefined ? {} : { file } } : {}),
    };
  });
  const profiles = names(data.profiles ?? {}, "profiles", (raw, name): ArtifactProfile => {
    const profile = fields(raw, ["builder", "projects", "workspace", "variants"], `profile ${name}`);
    const builder = choices(profile.builder, ["native", "nix", "guix"], `${name}.builder`);
    const projects = items(profile.projects, `${name}.projects`);
    for (const id of projects) if (!registered.has(id)) throw new InvalidInput(`${name}: unknown project '${id}'`);
    if (!Array.isArray(profile.variants) || !profile.variants.length)
      throw new InvalidInput(`${name}: declare at least one artifact variant`);
    const selected = new Set<string>();
    const variants = profile.variants.map((raw: unknown): ArtifactVariant => {
      const variant = fields(raw, ["target", "kind", "formats", "recipe", "ci_skip_reason"], `variant of ${name}`);
      const target = string(variant.target, `${name}: variant needs a target`);
      const recipe = string(variant.recipe, `${name}: variant needs a recipe`);
      const kind = choices(variant.kind, artifactKinds, `${name}.kind`);
      const targetSettings = Object.hasOwn(targets, target) ? targets[target] : undefined;
      const definition = Object.hasOwn(recipes, recipe) ? recipes[recipe] : undefined;
      const owner = definition?.owner;
      if (!targetSettings) throw new InvalidInput(`${name}: unknown target '${target}'`);
      if (!owner || !projects.includes(owner))
        throw new InvalidInput(`${name}: recipe '${recipe}' needs a selected project owner`);
      if (kind !== "release" && usesReleaseTag(definition))
        throw new InvalidInput(`${name}: {tag} applies to release recipes`);
      if (builder !== "native" && !targetSettings.platform.startsWith("linux-"))
        throw new InvalidInput(`${name}: ${builder} requires a Linux target`);
      const formats = items(variant.formats, `${name}.formats`).map((format) =>
        choices(format, artifactFormats, `${name}.formats`),
      );
      for (const format of formats) {
        if (!supportedFormat(format, targetSettings, builder))
          throw new InvalidInput(`${name}: ${format} is unavailable for ${builder} on ${targetSettings.platform}`);
        if ("offlineProfile" in definition && (format !== "oci" || kind === "release"))
          throw new InvalidInput(`${name}: offline profiles produce development or toolchain OCI images`);
        if (format === "oci" && !("offlineProfile" in definition))
          throw new InvalidInput(`${name}: OCI outputs require an offline image profile`);
        if (
          "storeProfile" in definition &&
          (format !== `${builder}-export` || kind === "release" || profile.workspace === "devcontainer")
        )
          throw new InvalidInput(
            `${name}: store profiles produce native manager toolchain or development exports in a host workspace`,
          );
        if ("package" in definition && (kind !== "release" || (!definition.package.file && format !== "archive")))
          throw new InvalidInput(`${name}: package a release directory as an archive or name its packaged output file`);
        if (
          "nativeProfile" in definition &&
          (format !== "archive" ||
            builder !== "native" ||
            !targetSettings.platform.startsWith("linux-") ||
            kind === "release" ||
            profile.workspace === "devcontainer")
        )
          throw new InvalidInput(
            `${name}: native preparation profiles produce Linux toolchain or development archives in a host workspace`,
          );
        const key = JSON.stringify([owner, target, kind, format]);
        if (selected.has(key)) throw new InvalidInput(`${name}: duplicate ${kind} ${format} for ${owner} on ${target}`);
        selected.add(key);
      }
      const ciSkipReason =
        variant.ci_skip_reason === undefined ? undefined : items([variant.ci_skip_reason], `${name}.ci_skip_reason`)[0];
      if (ciSkipReason && kind !== "release")
        throw new InvalidInput(`${name}: ci_skip_reason applies to release packaging`);
      return { target, kind, formats, recipe, ...(ciSkipReason ? { ci_skip_reason: ciSkipReason } : {}) };
    });
    return {
      builder,
      projects,
      workspace: choices(profile.workspace ?? "host", ["host", "devcontainer"], `${name}.workspace`),
      variants,
    };
  });
  const destinations = names(data.destinations ?? {}, "destinations", (raw, name): ArtifactDestination => {
    const destination = record(raw, `Invalid destination ${name}`);
    const context = `destination ${name}`;
    const kind = choices(destination.kind, ["registry", "github", "gitlab"], context);
    if (kind === "gitlab") {
      fields(raw, ["kind", "host", "project"], context);
      const host = new URL(string(destination.host, `${context}: expected an HTTPS host`));
      if (host.protocol !== "https:" || host.href !== host.origin + "/")
        throw new InvalidInput(`${context}: expected an HTTPS origin without credentials or a path`);
      const project = string(destination.project, `${context}: expected a project ID or path`);
      if (!/^(?:[1-9]\d*|[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)$/.test(project))
        throw new InvalidInput(`${context}: invalid GitLab project`);
      return { kind, host: host.origin, project };
    }
    fields(raw, ["kind", "repository"], context);
    const repository = string(destination.repository, `${context}: expected a repository`);
    if (kind === "registry" ? !imageRepository(repository) : !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
      throw new InvalidInput(`${context}: invalid ${kind} repository`);
    return { kind, repository };
  });
  const triggers = fields(data.publication ?? {}, ["branch", "tag"], "publication");
  const publication: ArtifactCatalog["publication"] = {};
  const catalog = { targets, recipes, profiles, destinations, publication };
  for (const trigger of ["branch", "tag"] as const) {
    if (triggers[trigger] === undefined) continue;
    const context = `publication.${trigger}`;
    const rule = fields(triggers[trigger], ["refs", "profiles", "target", "targets", "kind", "destination"], context);
    const refs = items(rule.refs, `${context}.refs`);
    for (const name of refs)
      if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*\*?$/.test(name) || name.includes(".."))
        throw new InvalidInput(`${context}: refs use exact names or a trailing wildcard`);
    const destination = string(rule.destination, `${context}: select a destination`);
    const delivery = Object.hasOwn(destinations, destination) ? destinations[destination] : undefined;
    if (!delivery || (delivery.kind === "registry") !== (trigger === "branch"))
      throw new InvalidInput(`${context}: branch snapshots need a registry and version tags need a release host`);
    const allowed = trigger === "branch" ? (["toolchain", "development"] as const) : (["release"] as const);
    const kind = choices(rule.kind ?? allowed[0], allowed, `${context}.kind`);
    const names = items(rule.profiles, `${context}.profiles`);
    if (rule.targets !== undefined && (trigger === "branch" || rule.target !== undefined))
      throw new InvalidInput(`${context}: use target for branch pushes, or select target or targets for version tags`);
    const targetNames = items(rule.targets ?? [rule.target], `${context}.targets`);
    const rows =
      trigger === "tag"
        ? releasePackageRows(catalog, { profiles: names, targets: targetNames })
        : targetNames.flatMap((target) =>
            artifactPlan(catalog, { profiles: names, target, kinds: [kind], format: "oci" }),
          );
    if (trigger === "tag" && new Set(rows.map((row) => row.definition.owner)).size !== 1)
      throw new InvalidInput(`${context}: the selected artifacts must belong to one release owner`);
    publication[trigger] = {
      refs,
      profiles: names,
      targets: targetNames.map((name) => ({ name, platform: required(targets[name], "Publication target").platform })),
      kind,
      destination,
    };
  }
  return catalog;
}

export function readArtifactCatalog(root: string, alternate?: string): ArtifactCatalog {
  const path = alternate ? resolve(root, alternate) : ownedPath(root, projectPaths.profiles);
  if (!alternate && !existsSync(path)) return decodeArtifactCatalog({ schema_version: 1 }, new Set());
  const registered = new Set(readProjects(root).map(({ id }) => id));
  return checkArtifactProfiles(root, decodeArtifactCatalog(readConfigurationToml(path), registered));
}

export function checkArtifactProfiles(root: string, catalog: ArtifactCatalog): ArtifactCatalog {
  const recipes = Object.entries(catalog.recipes).flatMap<{
    name: string;
    profile: string;
    archive?: "managed" | "native";
  }>(([name, definition]) =>
    "offlineProfile" in definition
      ? [{ name, profile: definition.offlineProfile }]
      : "storeProfile" in definition
        ? [{ name, profile: definition.storeProfile, archive: "managed" }]
        : "nativeProfile" in definition
          ? [{ name, profile: definition.nativeProfile, archive: "native" }]
          : [],
  );
  if (!recipes.length) return catalog;
  const profiles = readConfig(root).development?.profiles ?? [];
  const prepared = new Map<string, { builder: Builder; kind: ArtifactKind }>();
  for (const { name, profile, archive } of recipes) {
    const source = profiles.find((entry) => entry.name === profile);
    if (
      !source?.offline ||
      !source.container_config ||
      (archive === "managed" && (source.builder === "native" || !source.offline.prepare)) ||
      (archive === "native" && source.builder !== "native")
    )
      throw new InvalidInput(
        `${name}: '${profile}' does not declare ${archive ? `${archive} preparation` : "a prepared image"}`,
      );
    prepared.set(name, { builder: source.builder, kind: source.offline.kind ?? "development" });
  }
  for (const [name, profile] of Object.entries(catalog.profiles)) {
    for (const { kind, recipe } of profile.variants) {
      const source = prepared.get(recipe);
      if (source && (source.builder !== profile.builder || source.kind !== kind))
        throw new InvalidInput(`${name}: recipe '${recipe}' selects a ${source.builder} ${source.kind} profile`);
    }
  }
  return catalog;
}

export function artifactHost(): string {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${process.arch}`;
}

export interface ArtifactSelection {
  profiles?: readonly string[];
  all?: boolean;
  kinds?: readonly string[];
  target?: string;
  allTargets?: boolean;
  format?: string;
  tag?: string;
}

function profileRows(catalog: ArtifactCatalog, name: string) {
  const profile = Object.hasOwn(catalog.profiles, name) ? catalog.profiles[name] : undefined;
  if (!profile) throw new InvalidInput(`Unknown artifact profile '${name}'`);
  return profile.variants.flatMap((variant) => {
    const target = catalog.targets[variant.target];
    const recipe = catalog.recipes[variant.recipe];
    if (!target || !recipe) throw new InvalidInput(`${name}: incomplete artifact variant`);
    return variant.formats.map((format) => ({
      profile: name,
      builder: profile.builder,
      workspace: profile.workspace,
      target: variant.target,
      platform: target.platform,
      requirements: target,
      kind: variant.kind,
      format,
      recipe: variant.recipe,
      definition: recipe,
      ...(variant.ci_skip_reason ? { ciSkipReason: variant.ci_skip_reason } : {}),
      archive:
        format === "archive"
          ? target.platform.startsWith("linux-")
            ? ("tar.gz" as const)
            : ("zip" as const)
          : undefined,
    }));
  });
}

export type ArtifactPlanEntry = ReturnType<typeof profileRows>[number] & { releaseTag?: string };

export function isReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag);
}

export function withArtifactTag(row: ArtifactPlanEntry, tag: string | undefined): ArtifactPlanEntry {
  if (!tag || row.kind !== "release" || !usesReleaseTag(row.definition)) return row;
  if (!isReleaseTag(tag)) throw new InvalidInput("Select a version tag");
  return { ...row, releaseTag: tag };
}

/** Select each configured release output. Profiles can cover different subsets of the requested targets. */
export function releasePackageRows(
  catalog: ArtifactCatalog,
  selection?: { profiles: readonly string[]; targets: readonly string[] },
): ArtifactPlanEntry[] {
  const profiles = selection?.profiles ?? Object.keys(catalog.profiles).sort();
  const rows = profiles.flatMap((profile) =>
    profileRows(catalog, profile).filter(
      ({ kind, target }) => kind === "release" && (selection === undefined || selection.targets.includes(target)),
    ),
  );
  if (!selection) return rows;
  for (const target of selection.targets)
    if (!rows.some((row) => row.target === target))
      throw new InvalidInput(`No selected release artifact for '${target}'`);
  for (const profile of selection.profiles)
    if (!rows.some((row) => row.profile === profile))
      throw new InvalidInput(`${profile}: no release artifact for the selected targets`);
  return rows;
}

export function distinctArtifactBuilds(rows: readonly ArtifactPlanEntry[]): ArtifactPlanEntry[] {
  const seen = new Set<string>();
  return rows.filter(({ builder, workspace, target, kind, format, recipe }) => {
    const key = JSON.stringify([builder, workspace, target, kind, format, recipe]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function artifactPlan(catalog: ArtifactCatalog, selection: ArtifactSelection, host = artifactHost()) {
  const profiles = selection.profiles ?? [];
  if (selection.all && profiles.length) throw new InvalidInput("Select named profiles or --all");
  if (!selection.all && !profiles.length) throw new InvalidInput("Select a profile or --all");
  const kinds = items(selection.kinds ?? [], "Select at least one --kind").map((kind) =>
    choices(kind, artifactKinds, "--kind"),
  );
  if (selection.format) choices(selection.format, artifactFormats, "--format");
  if (selection.target && !Object.hasOwn(catalog.targets, selection.target))
    throw new InvalidInput(`Unknown artifact target '${selection.target}'`);
  const names = selection.all ? Object.keys(catalog.profiles).sort() : items(profiles, "Profiles");
  if (!names.length) throw new InvalidInput(`No artifact profiles configured in ${projectPaths.profiles}`);
  const requireKinds = (rows: readonly { kind: ArtifactKind }[], subject: string) => {
    for (const kind of kinds)
      if (!rows.some((row) => row.kind === kind))
        throw new InvalidInput(
          `${subject}: no ${kind} artifact for ${selection.target ?? (selection.allTargets ? "any target" : host)}${selection.format ? ` in ${selection.format} format` : ""}; inspect 'workbench artifact list'`,
        );
  };
  const selected = names.flatMap((name) => {
    const rows = profileRows(catalog, name).filter(
      (row) =>
        kinds.includes(row.kind) &&
        (selection.target ? row.target === selection.target : selection.allTargets === true || row.platform === host) &&
        (!selection.format || row.format === selection.format),
    );
    if (!selection.all) requireKinds(rows, name);
    return rows;
  });
  if (selection.all) requireKinds(selected, "Configured profiles");
  return selected.map((row) => withArtifactTag(row, selection.tag));
}
