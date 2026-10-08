import { resolve, sep } from "node:path";
import { readLanguageRoots, selectProject, type CheckDefinition } from "./core.js";
import { checkEnvironment, type CheckEnvironment } from "./environments.js";
import type { ConfiguredCheck } from "./checks.js";

export const checkStages = ["commit", "ci"] as const;
export interface CheckSelection {
  compiler?: string;
  compilerVersion?: string;
  role?: string;
  stage?: string;
  path?: string;
  project?: string;
  environment?: string;
  operatingSystem?: string;
}

export function selectedValues(value: unknown, allowed: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string" || !allowed.includes(item)))
    throw new Error(`${label}: expected a list drawn from ${allowed.join(", ")}`);
  if (new Set(value).size !== value.length) throw new Error(`${label}: duplicate selection`);
  return value as string[];
}

export function commandArguments(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.some((part: unknown) => typeof part !== "string" || !part))
    throw new Error(`${label}: needs a nonempty command array`);
}

export function checkPolicy(entry: CheckDefinition) {
  const stages = selectedValues(entry.stages ?? [...checkStages], checkStages, `${entry.name}: stages`);
  if (entry.role === "coverage") throw new Error(`${entry.name}: declare coverage as a test check's variant`);
  let coverage;
  if (entry.coverage !== undefined) {
    if (entry.role !== "test") throw new Error(`${entry.name}: coverage requires a test check and a table`);
    for (const key of Object.keys(entry.coverage))
      if (!["command", "stages", "operating_systems", "environments", "extensions"].includes(key))
        throw new Error(`${entry.name}: unknown coverage field '${key}'`);
    commandArguments(entry.coverage.command, `${entry.name}: coverage`);
    coverage = {
      command: entry.coverage.command,
      stages: selectedValues(entry.coverage.stages ?? ["ci"], checkStages, `${entry.name}: coverage.stages`),
      operatingSystems: selectedValues(
        entry.coverage.operating_systems ?? ["linux", "macos", "windows"],
        ["linux", "macos", "windows"],
        `${entry.name}: coverage.operating_systems`,
      ),
      environments: selectedValues(
        entry.coverage.environments ?? ["native"],
        ["native", "guix", "nix", "nix-docker", "devcontainer"],
        `${entry.name}: coverage.environments`,
      ),
    };
    if (coverage.stages.some((stage) => !stages.includes(stage)))
      throw new Error(`${entry.name}: coverage stages must also be selected by the test check`);
    if (!coverage.operatingSystems.length || !coverage.environments.length)
      throw new Error(`${entry.name}: coverage targets must not be empty; use stages = [] for manual coverage`);
  }
  return { stages, coverage };
}

export function hostOperatingSystem(): string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}

export function coverageApplies(check: ConfiguredCheck, stage: string, os: string, environment: string): boolean {
  return !!(
    check.coverage?.stages.includes(stage) &&
    check.coverage.operatingSystems.includes(os) &&
    check.coverage.environments.includes(environment)
  );
}

export function planChecks(root: string, checks: ConfiguredCheck[], options: CheckSelection = {}) {
  const stage = options.stage ?? (options.role ? undefined : "commit");
  if (stage !== undefined && !checkStages.some((value) => value === stage))
    throw new Error(`unknown check stage '${stage}'`);
  if (options.project && options.path !== undefined) throw new Error("select --project or --path, not both");
  if (options.path !== undefined && !readLanguageRoots(root).some((entry) => entry.path === options.path))
    throw new Error(`--path must name a registered language root: '${options.path}'`);
  const project = options.project ? selectProject(root, options.project) : undefined;
  const override = options.environment ? checkEnvironment(options.environment, "environment") : undefined;
  const executionOS = (environment: CheckEnvironment) =>
    options.operatingSystem ??
    (environment === "devcontainer" || environment === "nix-docker" ? "linux" : hostOperatingSystem());
  const scoped = checks.filter((check) => {
    if (options.path !== undefined) return check.directory === resolve(root, options.path);
    if (!project || project.path === ".") return true;
    const directory = resolve(root, project.path);
    return check.directory === directory || check.directory.startsWith(`${directory}${sep}`);
  });
  const chosen = scoped.filter(
    (check) =>
      (!stage || check.stages.includes(stage)) &&
      (options.role === "setup" || check.role !== "setup") &&
      (!options.role ||
        (options.role === "coverage"
          ? !!check.coverage &&
            (!stage ||
              coverageApplies(check, stage, executionOS(override ?? check.environment), override ?? check.environment))
          : check.role === options.role)),
  );
  const cleanup = options.role === "clean" || options.role === "distclean";
  const sessions = new Map<string, { directory: string; environment: CheckEnvironment; checks: ConfiguredCheck[] }>();
  for (const check of chosen) {
    const environment = cleanup ? "native" : (override ?? check.environment);
    if (environment === "nix-docker" && options.role && ["build", "release", "format-write"].includes(options.role))
      throw new Error(
        `${options.role}: nix-docker discards workspace outputs; select native, guix, nix, or devcontainer`,
      );
    const key = `${check.directory}\0${environment}`;
    let session = sessions.get(key);
    if (!session) {
      session = { directory: check.directory, environment, checks: [] };
      // Explicit role runs include setup even when it has no automatic stages.
      // Automatic gates reject setup excluded by their stage instead of using stale dependencies.
      if (!cleanup && options.role !== "setup") {
        const setup = checks.filter(
          (candidate) =>
            candidate.directory === check.directory &&
            candidate.role === "setup" &&
            (override ?? candidate.environment) === environment,
        );
        if (stage && setup.some((candidate) => !candidate.stages.includes(stage)))
          throw new Error(`${check.name}: setup is excluded from stage '${stage}'`);
        session.checks.push(...setup);
      }
      sessions.set(key, session);
    }
    if (session.checks.includes(check)) continue;
    const instrumented =
      options.role === "coverage" || (stage && coverageApplies(check, stage, executionOS(environment), environment));
    session.checks.push(
      instrumented && check.coverage
        ? { ...check, role: "coverage", command: check.coverage.command, warnSeconds: undefined }
        : check,
    );
  }
  return { stage, sessions: [...sessions.values()], cleanup };
}
