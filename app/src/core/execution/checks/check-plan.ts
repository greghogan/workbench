import { selectedValues, normalizeTargets, targetExclusion } from "./check-targets.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import { resolve, sep } from "node:path";
import { readLanguageRoots, selectProject } from "../../projects/project-configuration.js";
import { type CheckDefinition } from "../../projects/project-model.js";
import { checkEnvironment, type CheckEnvironment } from "../environments/environments.js";
import type { ConfiguredCheck } from "./check-configuration.js";
import { toolProfile } from "../../toolchains/tool-profiles.js";
import { readCheckOrder } from "./check-order.js";
import { CheckNetwork, readCheckNetwork } from "./check-network.mjs";
import type { CheckIsolationGroup } from "./check-isolation.js";

export const checkStages = ["commit", "ci"] as const;
export const manualCheckRoles = [
  "clean",
  "distclean",
  "format-write",
  "release",
  "release-verify",
  "compatibility-setup",
  "compatibility-test",
];
export interface CheckSelection {
  cache?: boolean;
  verbose?: boolean;
  compiler?: string;
  compilerVersion?: string;
  toolchain?: string | false;
  role?: string[];
  excludeRole?: string[];
  report?: string;
  stage?: string;
  extended?: boolean;
  offline?: boolean;
  network?: CheckNetwork;
  /** The online half of a combined gate follows the pre-commit selection. */
  afterCommit?: boolean;
  path?: string;
  project?: string;
  environment?: string;
  profile?: string;
  workspace?: "host" | "devcontainer";
  operatingSystem?: string;
  architecture?: string;
  /** Internal worker selection from the coordinator's already validated plan. */
  checkNames?: string[];
  isolationGroups?: CheckIsolationGroup[] | undefined;
  isolationDigest?: string;
  preparedSource?: string;
  machineJobserver?: string;
  parallelJobs?: number;
}

export type CheckPlan = ReturnType<typeof planChecks> & {
  resourceSessions?: number;
  isolated?: { directory: string; group: CheckIsolationGroup }[];
};

export function commandArguments(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.some((part: unknown) => typeof part !== "string" || !part))
    throw new InvalidInput(`${label}: needs a nonempty command array`);
}

export function checkPolicy(entry: CheckDefinition) {
  if (entry.extended !== undefined && typeof entry.extended !== "boolean")
    throw new InvalidInput(`${entry.name}: extended must be Boolean`);
  if (entry.extended && (entry.role === "setup" || manualCheckRoles.includes(entry.role)))
    throw new InvalidInput(`${entry.name}: ${entry.role} cannot be an extended check`);
  if (entry.online !== undefined && typeof entry.online !== "boolean")
    throw new InvalidInput(`${entry.name}: online must be Boolean`);
  if (entry.parallel !== undefined && typeof entry.parallel !== "boolean")
    throw new InvalidInput(`${entry.name}: parallel must be Boolean`);
  if (entry.parallel && (entry.online || !["docs", "format", "license", "lint", "test", "type"].includes(entry.role)))
    throw new InvalidInput(
      `${entry.name}: parallel requires an offline docs, format, license, lint, test, or type check`,
    );
  if (entry.requires_setup !== undefined && typeof entry.requires_setup !== "boolean")
    throw new InvalidInput(`${entry.name}: requires_setup must be Boolean`);
  const stages = selectedValues(
    entry.stages ?? (entry.extended ? [] : entry.online ? ["ci"] : [...checkStages]),
    checkStages,
    `${entry.name}: stages`,
  );
  if (manualCheckRoles.includes(entry.role) && stages.length)
    throw new InvalidInput(`${entry.name}: ${entry.role} must be manual-only (stages = [])`);
  if (entry.role === "coverage") throw new InvalidInput(`${entry.name}: declare coverage as a test check's variant`);
  let coverage;
  if (entry.coverage !== undefined) {
    if (entry.role !== "test") throw new InvalidInput(`${entry.name}: coverage requires a test check and a table`);
    for (const key of Object.keys(entry.coverage))
      if (!["command", "stages", "operating_systems", "environments", "ci", "extensions"].includes(key))
        throw new InvalidInput(`${entry.name}: unknown coverage field '${key}'`);
    commandArguments(entry.coverage.command, `${entry.name}: coverage`);
    coverage = {
      command: entry.coverage.command,
      stages: selectedValues(
        entry.coverage.stages ?? (entry.online ? stages : [...checkStages]),
        checkStages,
        `${entry.name}: coverage.stages`,
      ),
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
      ci: normalizeTargets(
        {
          ...entry.coverage.ci,
          ...((entry.coverage.ci?.operating_systems ?? entry.coverage.operating_systems)
            ? { operating_systems: entry.coverage.ci?.operating_systems ?? entry.coverage.operating_systems }
            : {}),
          environments: entry.coverage.ci?.environments ?? entry.coverage.environments ?? ["native"],
        },
        `${entry.name}: coverage.ci`,
      ),
    };
    if (coverage.stages.some((stage) => !stages.includes(stage)))
      throw new InvalidInput(`${entry.name}: coverage stages must also be selected by the test check`);
    if (!coverage.operatingSystems.length || !coverage.environments.length)
      throw new InvalidInput(`${entry.name}: coverage targets must not be empty; use stages = [] for manual coverage`);
  }
  const ciTargets = entry.ci === undefined ? undefined : normalizeTargets(entry.ci, `${entry.name}: ci`);
  return {
    stages,
    coverage,
    ...(ciTargets === undefined ? {} : { ciTargets }),
    online: entry.online ?? false,
    ...(entry.parallel ? { parallel: true } : {}),
    extended: entry.extended ?? false,
    requiresSetup: entry.requires_setup ?? true,
  };
}

export function hostOperatingSystem(): string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}

export function coverageApplies(
  check: ConfiguredCheck,
  stage: string,
  os: string,
  environment: string,
  architecture: string = process.arch,
  toolchain: string | false = false,
): boolean {
  const coverage = check.coverage;
  if (!coverage?.stages.includes(stage)) return false;
  const targets = stage === "ci" ? coverage.ci : coverage;
  return targetExclusion(targets, { operatingSystem: os, environment, architecture, toolchain }) === undefined;
}

export function planChecks(
  root: string,
  checks: ConfiguredCheck[],
  options: CheckSelection = {},
  workerDirectory?: string,
) {
  readCheckNetwork(options.network);
  const ordering = readCheckOrder(root, checks);
  const roles = [...new Set(options.role ?? [])],
    excludedRoles = [...new Set(options.excludeRole ?? [])];
  const focused = roles.length > 0 || excludedRoles.length > 0;
  const knownRoles = new Set([
    ...checks.map((check) => check.role),
    ...(checks.some((check) => check.coverage) ? ["coverage"] : []),
  ]);
  for (const role of [...roles, ...excludedRoles])
    if (!knownRoles.has(role)) throw new InvalidInput(`unknown check role '${role}'`);
  if (roles.some((role) => excludedRoles.includes(role)))
    throw new InvalidInput("a role cannot be both included and excluded");
  const cleanup = roles.includes("clean") || roles.includes("distclean");
  if (cleanup && roles.length !== 1) throw new InvalidInput("cleanup roles must be selected alone");
  const stage = options.stage ?? (roles.length ? undefined : "commit");
  if (stage !== undefined && !checkStages.some((value) => value === stage))
    throw new Error(`unknown check stage '${stage}'`);
  if (options.project && options.path !== undefined) throw new Error("select --project or --path, not both");
  if (options.path !== undefined && !readLanguageRoots(root).some((entry) => entry.path === options.path))
    throw new Error(`--path must name a registered language root: '${options.path}'`);
  const project = options.project ? selectProject(root, options.project) : undefined;
  const toolchain = toolProfile(root, options.toolchain);
  if (toolchain && options.path !== undefined && !toolchain.paths.includes(options.path))
    throw new Error(`tool profile '${toolchain.name}' does not select '${options.path}'`);
  const profileRoots = toolchain ? new Set(toolchain.paths.map((path) => resolve(root, path))) : undefined;
  const override = options.environment ? checkEnvironment(options.environment, "environment") : undefined;
  const executionOS = (environment: CheckEnvironment) =>
    options.operatingSystem ??
    (environment === "devcontainer" || environment === "nix-docker" ? "linux" : hostOperatingSystem());
  const includesCoverage = (check: ConfiguredCheck, environment: CheckEnvironment) =>
    coverageApplies(
      check,
      stage ?? "commit",
      executionOS(environment),
      environment,
      options.architecture ?? process.arch,
      toolchain?.name ?? false,
    );
  const scoped = checks.filter((check) => {
    if (workerDirectory && check.directory !== workerDirectory) return false;
    if (profileRoots && !profileRoots.has(check.directory)) return false;
    if (options.path !== undefined) return check.directory === resolve(root, options.path);
    if (!project || project.path === ".") return true;
    const directory = resolve(root, project.path);
    return check.directory === directory || check.directory.startsWith(`${directory}${sep}`);
  });
  const instrumented = (check: ConfiguredCheck) =>
    !!check.coverage &&
    (roles.includes("coverage") || (!!stage && includesCoverage(check, override ?? check.environment)));
  const includeExtended = (check: ConfiguredCheck) => options.extended === true && check.extended;
  const alreadySelected = (check: ConfiguredCheck) =>
    options.afterCommit === true && includeExtended(check) && check.stages.includes("commit");
  const inRegularStage = (check: ConfiguredCheck) => !stage || check.stages.includes(stage);
  const inStage = (check: ConfiguredCheck) =>
    !alreadySelected(check) && (inRegularStage(check) || (includeExtended(check) && (!check.online || stage === "ci")));
  const ciExclusion = (check: ConfiguredCheck) =>
    stage !== "ci" && !(includeExtended(check) && (!stage || !inRegularStage(check)))
      ? undefined
      : targetExclusion(check.ciTargets ?? {}, {
          operatingSystem: executionOS(override ?? check.environment),
          environment: override ?? check.environment,
          architecture: options.architecture ?? process.arch,
          toolchain: toolchain?.name ?? false,
        });
  const chosen = scoped.filter(
    (check) =>
      ciExclusion(check) === undefined &&
      inStage(check) &&
      (options.network !== CheckNetwork.Online || check.online) &&
      (options.network !== CheckNetwork.Offline || !check.online) &&
      (roles.includes("setup") || check.role !== "setup") &&
      (!roles.length ||
        roles.includes(check.role) ||
        (roles.includes("coverage") &&
          !!check.coverage &&
          (!stage || includesCoverage(check, override ?? check.environment)))) &&
      !excludedRoles.includes(check.role) &&
      !(excludedRoles.includes("coverage") && instrumented(check)),
  );
  if (options.extended && stage)
    chosen.sort((left, right) => Number(right.stages.includes(stage)) - Number(left.stages.includes(stage)));
  const sessions = new Map<string, { directory: string; environment: CheckEnvironment; checks: ConfiguredCheck[] }>();
  for (const check of chosen) {
    const environment = cleanup ? "native" : (override ?? check.environment);
    if (environment === "nix-docker" && focused && ["build", "release", "format-write"].includes(check.role))
      throw new Error(
        `${check.role}: nix-docker discards workspace outputs; select native, guix, nix, or devcontainer`,
      );
    const key = `${check.directory}\0${environment}`;
    let session = sessions.get(key);
    if (!session) {
      session = { directory: check.directory, environment, checks: [] };
      sessions.set(key, session);
    }
    if (session.checks.includes(check)) continue;
    session.checks.push(
      instrumented(check) && check.coverage
        ? { ...check, role: "coverage", command: check.coverage.command, warnSeconds: undefined }
        : check,
    );
  }
  if (!cleanup) {
    for (const session of sessions.values()) {
      const buildNames = new Set(session.checks.flatMap((check) => check.requiresBuild ?? []));
      const builds = checks.filter((check) => buildNames.has(check.name));
      for (const build of builds) {
        const exclusion = ciExclusion(build);
        if (exclusion || excludedRoles.includes("build"))
          throw new InvalidInput(`Required build '${build.name}' is unavailable: ${exclusion ?? "build is excluded"}`);
      }
      if (builds.length) session.checks = [...builds, ...session.checks.filter((check) => !buildNames.has(check.name))];
      const dependent = session.checks.find((check) => check.role !== "setup" && check.requiresSetup);
      if (!dependent) continue;
      // Resolve prerequisites after grouping so an independent first check cannot hide later requirements.
      // Explicit role runs permit manual setup; automatic gates reject excluded required setup.
      const setup = checks.filter(
        (candidate) =>
          candidate.directory === session.directory &&
          candidate.role === "setup" &&
          (override ?? candidate.environment) === session.environment,
      );
      const unavailable = setup.find((candidate) => ciExclusion(candidate));
      if (unavailable)
        throw new InvalidInput(
          `${dependent.name}: required setup '${unavailable.name}' is unavailable: ${ciExclusion(unavailable) ?? "CI target excluded"}`,
        );
      if (stage && setup.some((candidate) => !candidate.stages.includes(stage)))
        throw new Error(`${dependent.name}: setup is excluded from stage '${stage}'`);
      if (setup.length && excludedRoles.includes("setup"))
        throw new InvalidInput(`${dependent.name}: required setup cannot be excluded`);
      session.checks = [...setup, ...session.checks.filter((check) => check.role !== "setup")];
    }
  }
  const selected = new Set([...sessions.values()].flatMap((session) => session.checks.map((check) => check.name)));
  const exclusionReason = (check: ConfiguredCheck) => {
    if (!scoped.includes(check)) return "outside selected scope";
    if (alreadySelected(check)) return "already selected in the pre-commit gate";
    const target = ciExclusion(check);
    if (target !== undefined) return target;
    if (!inStage(check))
      return check.extended && !options.extended ? "select --extended" : `excluded from ${stage ?? "selected"} stage`;
    if (options.network === CheckNetwork.Online && !check.online) return "not an online check";
    if (options.network === CheckNetwork.Offline && check.online) return "requires network access";
    if (check.role === "setup") return "no selected dependent checks";
    if (roles.includes("coverage") && check.coverage) return "coverage does not apply to selected target";
    if (focused)
      return `outside selected roles${excludedRoles.includes(check.role) ? ` (excluded ${check.role})` : ""}`;
    return "not selected";
  };
  const excluded = checks
    .filter((check) => !selected.has(check.name))
    .map((check) => ({ check, reason: exclusionReason(check) }));
  return {
    stage,
    sessions: [...sessions.values()],
    cleanup,
    excluded,
    ordering,
    automatic: !focused,
    offline: !!options.offline,
  };
}
