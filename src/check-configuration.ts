import { ownedPath } from "./paths.js";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rootOf } from "./project-context.js";
import { readConfig, readLanguageRoots, readProjects } from "./project-configuration.js";
import { readToml } from "./files.js";
import { type Project, type CheckDefinition } from "./project-model.js";
import { catalog } from "./language-config.js";
import { readCheckOrder } from "./check-order.js";
import { checkEnvironment, type CheckEnvironment } from "./environments.js";
import { checkPolicy, commandArguments } from "./check-plan.js";

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
  online: boolean;
  requiresSetup: boolean;
  coverage: ReturnType<typeof checkPolicy>["coverage"];
  source?: string;
}

const validRole = /^[a-z][a-z0-9-]*$/;

export function readChecks(root: string): ConfiguredCheck[] {
  const config = readConfig(root);
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
  const automation = ownedPath(root, "workbench/automation.toml");
  const projectSource =
    existsSync(automation) && Object.hasOwn(readToml(automation) as object, "check")
      ? automation
      : ownedPath(root, "workbench/config.toml");
  const languages = config.check_suite?.length ? catalog(root) : [];
  const roots = config.check_suite?.length ? readLanguageRoots(root) : [];
  for (const suite of config.check_suite ?? []) {
    if (!roots.some((entry) => entry.language === suite.language && entry.path === suite.path))
      throw new Error(`check_suite: register ${suite.language}@${suite.path} as a language root first`);
    const language = languages.find((entry) => entry.id === suite.language);
    if (!language) throw new Error(`check_suite: unknown language '${suite.language}'`);
    for (const check of language.command) {
      const name = `${suite.language}@${suite.path}: ${check.name ?? check.role}`;
      definitions.push({ ...check, name, path: suite.path });
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
          "stages",
          "online",
          "requires_setup",
          "environment",
          "warn_seconds",
          "coverage",
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
    const project = projects.find((candidate) => candidate.id === (entry.project ?? projects[0]?.id));
    if (!project) throw new Error(`check '${entry.name}' names unknown project '${String(entry.project)}'`);
    if (
      entry.path !== undefined &&
      (entry.project !== undefined ||
        (entry.path !== "." &&
          (isAbsolute(entry.path) ||
            entry.path.includes("\\") ||
            entry.path
              .split(/[\\/]/)
              .some(
                (part) =>
                  !part ||
                  part === "." ||
                  part === ".." ||
                  [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
              ))))
    )
      throw new Error(`check '${entry.name}' has an unsafe or ambiguous path`);
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
    };
  });
  readCheckOrder(root, checks);
  return checks;
}
