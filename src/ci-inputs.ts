import { readDistributionPin, validateDistributionPin, projectPinFile } from "./distribution-manifest.js";
import { resolveInstalledDistribution } from "./installation-project.js";
import { InvalidInput } from "./input-errors.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { parse, TomlError } from "smol-toml";
import { distributionRoot, configFromData, languageRootsFromData } from "./core.js";
import { languageSources, languageAutomationFromData } from "./language-config.js";
import { ownedPath, relativePath } from "./paths.js";

export interface Dependency {
  path: string;
  roots: string[];
  source: string;
}
export interface Inputs {
  roots: string[];
  dependencies: Dependency[];
  documentation: string[];
  ignored?: string[];
}

export interface ComparisonFailure {
  kind: "history" | "input" | "changes" | "checkout";
  operation: string;
  message: string;
}

/** Only acquisition/validation failures authorize conservative full-matrix fallback. */
export class ComparisonUnavailable extends Error {
  readonly failure: ComparisonFailure;
  constructor(kind: ComparisonFailure["kind"], operation: string, cause: unknown) {
    const message =
      (cause instanceof Error ? cause.message : String(cause)).split("\n")[0]?.slice(0, 512) ?? "unknown error";
    super(`${kind}: ${operation}: ${message}`, { cause });
    this.failure = { kind, operation, message };
  }
}

/** Classify only explicit validation, TOML, and filesystem failures at the input boundary. */
export function comparisonData<T>(kind: ComparisonFailure["kind"], operation: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof Error &&
      (error instanceof InvalidInput ||
        error instanceof TomlError ||
        ("code" in error &&
          typeof error.code === "string" &&
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EIO"].includes(error.code)))
    )
      throw new ComparisonUnavailable(kind, operation, error);
    throw error;
  }
}

export function comparisonGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ("status" in error || ("code" in error && typeof error.code === "string" && /^E[A-Z]+$/.test(error.code)))
    )
      throw new ComparisonUnavailable("history", `git ${args[0] ?? "comparison"}`, error);
    throw error;
  }
}
const portable = (value: string) => value.replaceAll("\\", "/");

/** Read historical declarations as data, never execute code or check out an old revision. */
function comparisonReader(root: string, commit?: string) {
  let distribution = distributionRoot(root);
  const shared = !!readDistributionPin(root);
  const prefix = shared ? ".workbench" : portable(relative(root, distribution)) || ".";
  relativePath(prefix, "Workbench distribution", true);
  const files = new Set(
    commit ? comparisonGit(root, ["ls-tree", "-rz", "--name-only", commit]).split("\0").filter(Boolean) : [],
  );
  let distributionCommit: string | undefined;
  let installed = shared && !commit;
  if (commit && files.has(projectPinFile)) {
    const pin: unknown = JSON.parse(comparisonGit(root, ["show", `${commit}:${projectPinFile}`]));
    validateDistributionPin(pin);
    distribution = resolveInstalledDistribution(root, pin).directory;
    installed = true;
  }
  if (commit && prefix !== ".") {
    const entry = comparisonGit(root, ["ls-tree", commit, "--", prefix]);
    distributionCommit = /^160000 commit ([0-9a-f]+)\t/.exec(entry)?.[1];
  }
  const cache = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    relativePath(path, "comparison input");
    if (cache.has(path)) return cache.get(path);
    let content: string | undefined;
    if (installed && path.startsWith(`${prefix}/`)) {
      const selected = ownedPath(distribution, path.slice(prefix.length + 1));
      content = existsSync(selected) ? readFileSync(selected, "utf8") : undefined;
    } else if (!commit) {
      const selected = ownedPath(root, path);
      content = existsSync(selected) ? readFileSync(selected, "utf8") : undefined;
    } else if (distributionCommit && path.startsWith(`${prefix}/`)) {
      content = comparisonGit(distribution, ["show", `${distributionCommit}:${path.slice(prefix.length + 1)}`]);
    } else if (files.has(path)) content = comparisonGit(root, ["show", `${commit}:${path}`]);
    cache.set(path, content);
    return content;
  };
  const toml = (path: string): Record<string, unknown> => {
    const content = read(path);
    if (content === undefined) throw new InvalidInput(`missing comparison input: ${path}`);
    return parse(content);
  };
  const localPath = "workbench/languages";
  const localIds = commit
    ? [
        ...new Set(
          [...files]
            .filter((file) => file.startsWith(`${localPath}/`))
            .map((file) => file.slice(localPath.length + 1).split("/")[0] ?? ""),
        ),
      ]
    : existsSync(ownedPath(root, localPath))
      ? readdirSync(ownedPath(root, localPath), { withFileTypes: true }).map((entry) => {
          if (!entry.isDirectory())
            throw new InvalidInput(`${localPath}/${entry.name}: expected a real language directory`);
          return entry.name;
        })
      : [];
  return { read, toml, localIds, sharedPath: (suffix: string) => (prefix === "." ? suffix : `${prefix}/${suffix}`) };
}

/** Normalize declarations without executing historical code or fetching history. */
export function ciInputs(root: string, commit?: string): Inputs {
  return comparisonData("input", `read declarations at ${commit ?? "working tree"}`, () => readCIInputs(root, commit));
}

function readCIInputs(root: string, commit?: string): Inputs {
  const { read, toml, localIds, sharedPath } = comparisonReader(root, commit);
  const registry = toml("workbench/projects.toml");
  const registered = languageRootsFromData(registry, "workbench/projects.toml");
  if (!registered.length) throw new InvalidInput("comparison registry has no language roots");
  const roots = [...new Set(registered.map((entry) => entry.path))];
  const automation = read("workbench/automation.toml");
  const config = configFromData(
    toml("workbench/config.toml"),
    automation === undefined ? undefined : parse(automation),
    "workbench/config.toml",
  );
  const sources = new Map(
    languageSources(toml(sharedPath("languages/index.toml")), localIds, "languages/index.toml").map((source) => [
      source.id,
      source,
    ]),
  );
  const dependencies: Dependency[] = [];
  const ignored: string[] = [];
  const add = (path: string, targets: string[], source: string) => {
    relativePath(path, source, true);
    if (targets.some((target) => !roots.includes(target))) throw new InvalidInput(`${source}: unknown CI root`);
    dependencies.push({ path, roots: targets, source });
  };
  if (read(projectPinFile) !== undefined) add(projectPinFile, roots, "exact Workbench distribution pin");
  const byLanguage = new Map<string, string[]>();
  for (const entry of registered) {
    const targets = byLanguage.get(entry.language) ?? [];
    targets.push(entry.path);
    byLanguage.set(entry.language, targets);
  }
  for (const [language, targets] of byLanguage) {
    const source = sources.get(language);
    if (!source) throw new InvalidInput(`comparison registry: unknown language '${language}'`);
    const definition = source.source === "shared" ? sharedPath(source.relative) : source.relative;
    if (source.source !== "shared") ignored.push(sharedPath(`languages/${language}`));
    add(definition, targets, `${language} selected language definition`);
    const automationPath = `${definition}/automation.toml`;
    for (const command of languageAutomationFromData(toml(automationPath), automationPath))
      for (const argument of [...command.command, ...(command.coverage?.command ?? [])])
        if (argument.startsWith("{workbench}/"))
          add(sharedPath(argument.slice("{workbench}/".length)), targets, `${language} command input`);
  }
  for (const [index, dependency] of (config.ci?.dependencies ?? []).entries())
    for (const path of dependency.paths) add(path, dependency.roots, `ci.dependencies[${String(index)}]`);
  const projects = registry.project as { path: string }[];
  const documentation = projects.flatMap(({ path }) => {
    const record = path === "." ? "workbench" : `${path}/workbench`;
    return ["decisions", "tasks", "experiments", "environments", "citations", "releases", "guides", "evidence"]
      .map((dir) => `${record}/${dir}`)
      .concat([`${record}/record-sequences.toml`, `${record}/release-index.tsv`]);
  });
  documentation.push(sharedPath("collections"));
  return { roots, dependencies, documentation, ignored };
}
