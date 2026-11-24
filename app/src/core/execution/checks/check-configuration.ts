import { projectPaths } from "../../projects/project-paths.js";
import { ownedPath, registeredRootPath } from "../../runtime/paths.js";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { rootOf } from "../../projects/project-context.js";
import { readConfig, readLanguageRoots, readProjects } from "../../projects/project-configuration.js";
import { type Project, type CheckDefinition } from "../../projects/project-model.js";
import { catalog } from "../../configuration/language-config.js";
import { readCheckOrder } from "./check-order.js";
import { checkEnvironment, type CheckEnvironment } from "../environments/environments.js";
import { checkPolicy, commandArguments } from "./check-plan.js";
import { checkInputGroups, type DeclaredCheckInputs } from "./check-input-scope.js";
import {
  withConfigurationSnapshot,
  readConfigurationToml as readToml,
} from "../../configuration/configuration-snapshot.js";

export interface ConfiguredCheck {
  name: string;
  role: string;
  command: string[];
  project: Project;
  directory: string;
  location: string;
  warnSeconds: number | undefined;
  environment: CheckEnvironment;
  dockerImage: string | undefined;
  stages: string[];
  extended: boolean;
  online: boolean;
  requiresSetup: boolean;
  requiresBuild?: string[];
  coverage: ReturnType<typeof checkPolicy>["coverage"];
  ciTargets?: import("./check-targets.js").CheckTargets;
  source?: string;
  inputs?: DeclaredCheckInputs;
}

const validRole = /^[a-z][a-z0-9-]*$/;

export function readChecks(root: string): ConfiguredCheck[] {
  return withConfigurationSnapshot(() => configuredChecks(root));
}

function configuredChecks(root: string): ConfiguredCheck[] {
  const config = readConfig(root);
  const inputGroups = checkInputGroups(config.input_groups);
  const projects = readProjects(root);
  if (config.checks?.allow_empty !== undefined && typeof config.checks.allow_empty !== "boolean")
    throw new Error("checks.allow_empty must be Boolean");
  const defaultEnvironment = checkEnvironment(config.checks?.environment ?? "native", "checks.environment");
  const dockerImage = config.checks?.nix_docker_image;
  if (
    dockerImage !== undefined &&
    (typeof dockerImage !== "string" || !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(dockerImage))
  )
    throw new Error("checks.nix_docker_image must be an image pinned by SHA-256 digest");
  if (defaultEnvironment === "nix-docker" && !dockerImage)
    throw new Error("checks.nix_docker_image is required for 'nix-docker'");
  const seen = new Set<string>();
  const definitions: CheckDefinition[] = [...(config.check ?? [])];
  const sources = new Map<string, string>();
  const automation = ownedPath(root, projectPaths.automation);
  const projectSource =
    existsSync(automation) && Object.hasOwn(readToml(automation) as object, "check")
      ? automation
      : ownedPath(root, projectPaths.config);
  const languages = config.check_suite?.length ? catalog(root) : [];
  const roots = config.check_suite?.length ? readLanguageRoots(root) : [];
  for (const suite of config.check_suite ?? []) {
    if (!roots.some((entry) => entry.language === suite.language && entry.path === suite.path))
      throw new Error(`check_suite: register ${suite.language}@${suite.path} as a language root first`);
    const language = languages.find((entry) => entry.id === suite.language);
    if (!language) throw new Error(`check_suite: unknown language '${suite.language}'`);
    const context = `check_suite '${suite.language}@${suite.path}'`;
    inputGroups(suite.input_groups, context);
    for (const name of Object.keys(suite.check_inputs ?? {}))
      if (!language.command.some((check) => (check.name ?? check.role) === name))
        throw new Error(`${context}: check_inputs names unknown check '${name}'`);
    for (const check of language.command) {
      const label = check.name ?? check.role;
      const name = `${suite.language}@${suite.path}: ${label}`;
      const groups = Object.hasOwn(suite.check_inputs ?? {}, label) ? suite.check_inputs?.[label] : suite.input_groups;
      definitions.push({ ...check, name, path: suite.path, ...(groups === undefined ? {} : { input_groups: groups }) });
      sources.set(name, `${language.source}: ${join(language.directory, "automation.toml")}`);
    }
  }
  const checks = definitions.map((entry) => {
    for (const key of Object.keys(entry))
      if (
        ![
          "name",
          "role",
          "project",
          "path",
          "command",
          "input_groups",
          "stages",
          "extended",
          "online",
          "requires_setup",
          "requires_build",
          "environment",
          "warn_seconds",
          "coverage",
          "ci",
          "extensions",
        ].includes(key)
      )
        throw new Error(`check '${entry.name}': unknown field '${key}'`);
    if (typeof entry.name !== "string" || !entry.name.trim() || seen.has(entry.name))
      throw new Error("every check needs a unique nonempty name");
    seen.add(entry.name);
    const role = entry.role;
    if (!validRole.test(role)) throw new Error(`check '${entry.name}' has an invalid role`);
    commandArguments(entry.command, `check '${entry.name}'`);
    const policy = checkPolicy(entry);
    if (
      typeof policy.ciTargets?.toolchain === "string" &&
      !config.toolchains?.profiles?.some((profile) => profile.name === policy.ciTargets?.toolchain)
    )
      throw new Error(`${entry.name}: ci.toolchain names an unknown tool profile`);
    const project = projects.find((candidate) => candidate.id === (entry.project ?? projects[0]?.id));
    if (!project) throw new Error(`check '${entry.name}' names unknown project '${String(entry.project)}'`);
    if (entry.path !== undefined && entry.project !== undefined)
      throw new Error(`check '${entry.name}' has an unsafe or ambiguous path`);
    if (entry.path !== undefined) registeredRootPath(entry.path, `check '${entry.name}' path`);
    if (entry.path) ownedPath(root, entry.path);
    if (entry.path && entry.path !== ".") {
      let directory = root;
      for (const component of entry.path.split("/")) {
        directory = join(directory, component);
        if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
          throw new Error(`check '${entry.name}' path must be a real directory`);
      }
    }
    if (entry.warn_seconds !== undefined && (!Number.isFinite(entry.warn_seconds) || entry.warn_seconds <= 0))
      throw new Error(`check '${entry.name}' warn_seconds must be positive`);
    const selectedEnvironment = checkEnvironment(
      entry.environment ?? defaultEnvironment,
      `check '${entry.name}' environment`,
    );
    if (selectedEnvironment === "nix-docker" && !dockerImage)
      throw new Error(`check '${entry.name}' needs checks.nix_docker_image`);
    const inputs = inputGroups(entry.input_groups, `check '${entry.name}'`);
    const requiresBuild = entry.requires_build;
    if (
      requiresBuild !== undefined &&
      (!Array.isArray(requiresBuild) ||
        !requiresBuild.length ||
        requiresBuild.some((name) => typeof name !== "string" || !name.trim()) ||
        new Set(requiresBuild).size !== requiresBuild.length ||
        ["setup", "acquire", "build", "clean", "distclean"].includes(role))
    )
      throw new Error(`check '${entry.name}': requires_build must name distinct prerequisite build checks`);
    return {
      ...policy,
      name: entry.name,
      role,
      command: entry.command,
      project,
      directory: entry.path === undefined ? rootOf(root, project) : join(root, entry.path),
      location: entry.path ?? project.id,
      warnSeconds: entry.warn_seconds,
      environment: selectedEnvironment,
      dockerImage,
      source: sources.get(entry.name) ?? `project: ${projectSource}`,
      ...(inputs === undefined ? {} : { inputs }),
      ...(requiresBuild === undefined ? {} : { requiresBuild }),
    };
  });
  const byName = new Map(checks.map((check) => [check.name, check]));
  for (const check of checks) {
    const outputs: string[] = [];
    for (const name of check.requiresBuild ?? []) {
      const prerequisite = byName.get(name);
      if (
        prerequisite?.role !== "build" ||
        prerequisite.directory !== check.directory ||
        prerequisite.environment !== check.environment ||
        prerequisite.online ||
        !prerequisite.inputs?.outputs?.length
      )
        throw new Error(
          `check '${check.name}': '${name}' must be a build in the same root and environment with declared outputs`,
        );
      for (const path of prerequisite.inputs.outputs) {
        if (outputs.some((other) => path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))
          throw new Error(`check '${check.name}': prerequisite build outputs overlap at '${path}'`);
        outputs.push(path);
      }
    }
  }
  readCheckOrder(root, checks);
  return checks;
}
