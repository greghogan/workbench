import { join, relative } from "node:path";
import { readConfig } from "../../projects/project-configuration.js";
import { required } from "../../runtime/invariants.js";
import type { ConfiguredCheck } from "./check-configuration.js";
import type { CheckDependency } from "./check-order.js";
import type { CheckPlan } from "./check-plan.js";
import { checkExecution } from "./check-resources.js";
import { checkScopes, reusableChecks } from "./check-input-scope.js";
import { existsSync } from "node:fs";
import { usesPreparedCheckModules, type CheckIsolationBackend } from "./check-isolation.js";
import { buildStorageSettings } from "../../artifacts/builds.js";
import { distributionRoot } from "../../projects/project-context.js";
import { usesRubyCheckInstallation } from "../../toolchains/ruby-manager.js";

type Session = CheckPlan["sessions"][number];
type Phase = CheckDependency["phase"];

const regularRunnerRoles = new Set(["setup", "acquire", "build", "release", "release-verify", "format-write", "docs"]);

export function requiresWholeProjectCheck(check: ConfiguredCheck): boolean {
  return check.online || check.extended || regularRunnerRoles.has(check.role);
}

/** A prerequisite contributes only the phase that a downstream group consumes. */
function prerequisites(dependencies: readonly CheckDependency[][], index: number): Map<number, Phase> {
  const selected = new Map<number, Phase>();
  function visit(source: number): void {
    for (const { session, phase } of dependencies[source] ?? []) {
      const existing = selected.get(session);
      if (existing === "complete" || existing === phase) continue;
      selected.set(session, phase);
      visit(session);
    }
  }
  visit(index);
  return selected;
}

const forPhase = (session: Session, phase: Phase) =>
  phase === "complete" ? session.checks : session.checks.filter((check) => check.role === "setup");

function checkPartitions(session: Session): ConfiguredCheck[][] {
  const partitions = new Map<string, ConfiguredCheck[]>();
  for (const check of session.checks) {
    const build = check.role === "build" && !!check.inputs?.outputs?.length;
    const key =
      check.role === "setup" || check.role === "secret"
        ? check.role
        : JSON.stringify([
            check.inputs?.paths ?? null,
            check.inputs?.outputs ?? [],
            requiresWholeProjectCheck(check),
            build ? check.name : null,
            check.requiresBuild ?? [],
          ]);
    const partition = partitions.get(key);
    if (partition) partition.push(check);
    else partitions.set(key, [check]);
  }
  return [...partitions.values()];
}

export function scopedCheckGroups(root: string, plan: CheckPlan, requireIsolation = false) {
  if (process.platform === "win32" || plan.cleanup || plan.sessions.some(({ environment }) => environment !== "native"))
    return undefined;
  if (!plan.sessions.some((session) => reusableChecks(session.checks).some((check) => check.inputs))) return undefined;
  const partitions = plan.sessions.map(checkPartitions);
  if (
    !requireIsolation &&
    partitions.length === 1 &&
    (partitions[0]?.filter((checks) => checks.some((check) => check.role !== "setup" && check.role !== "secret"))
      .length ?? 0) < 2
  )
    return undefined;
  const { dependencies } = checkExecution(root, plan);
  const additional = readConfig(root).checks?.inputs;
  const rubySetups = new Map<string, boolean>();
  return plan.sessions.flatMap((session, index) => {
    const needed = prerequisites(dependencies, index);
    const setup = forPhase(session, "setup");
    const requiredBySession = new Set(session.checks.flatMap((check) => check.requiresBuild ?? []));
    return (partitions[index] ?? []).map((checks) => {
      const reusable = checks.every((check) => check.role !== "secret");
      const requiredBuilds = new Set(checks.flatMap((check) => check.requiresBuild ?? []));
      const builds = session.checks.filter((check) => requiredBuilds.has(check.name));
      const local = [...builds, ...checks];
      if (local.some((check) => check.role !== "setup" && check.requiresSetup)) local.unshift(...setup);
      const evidence = plan.sessions.flatMap((candidate, position) => {
        const phase = needed.get(position);
        if (candidate === session) return [{ ...session, checks: local }];
        return phase ? [{ ...candidate, checks: forPhase(candidate, phase) }] : [];
      });
      const declared = checkScopes(
        evidence.flatMap((candidate) =>
          candidate.checks.filter((check) => check.role !== "secret" && !requiredBuilds.has(check.name)),
        ),
        additional,
      );
      const requiredSetup = evidence.flatMap((candidate) =>
        candidate.checks
          .filter((check) => check.role === "setup")
          .map(({ command }) => ({ directory: candidate.directory, command })),
      );
      let preparedSetup: "ruby-gems" | undefined;
      if (requiredSetup.some(({ directory }) => directory === session.directory)) {
        const key = JSON.stringify([session.directory, requiredSetup]);
        if (!rubySetups.has(key))
          rubySetups.set(key, usesRubyCheckInstallation(session.directory, distributionRoot(root), requiredSetup));
        if (rubySetups.get(key)) preparedSetup = "ruby-gems";
      }
      const needsPreparedCache = requiredSetup.some(
        (setup) =>
          !usesPreparedCheckModules(root, [setup]) &&
          existsSync(join(setup.directory, "pnpm-lock.yaml")) &&
          (setup.command[0] !== "{packageManager}" ||
            setup.command[1] !== "install" ||
            !buildStorageSettings(root).external),
      );
      const scope =
        declared.mode === "scoped" && needsPreparedCache
          ? {
              mode: "whole-project" as const,
              paths: declared.paths,
              reason: "Offline setup uses the prepared environment's dependency caches",
            }
          : declared;
      return {
        index,
        session: { ...session, checks },
        path: relative(root, session.directory).replaceAll("\\", "/") || ".",
        prerequisites: needed,
        scope,
        setup: requiredSetup,
        preparedSetup,
        builds,
        build: checks.find((check) => requiredBySession.has(check.name)),
        reusable,
        evidence: { ...plan, sessions: evidence, resourceSessions: plan.sessions.length },
      };
    });
  });
}

type Group = NonNullable<ReturnType<typeof scopedCheckGroups>>[number];

/** Planning and execution use the same prerequisites when reporting the effective scope. */
export function checkGroupExecution(
  root: string,
  group: Group,
  isolation?: { backend: CheckIsolationBackend | undefined },
) {
  const { scope } = group;
  if (!isolation || scope.mode !== "scoped") return { scope, backend: undefined };
  const missingModules =
    isolation.backend &&
    usesPreparedCheckModules(root, group.setup) &&
    !existsSync(join(root, "node_modules/.modules.yaml"));
  if (
    isolation.backend &&
    !missingModules &&
    group.reusable &&
    !group.session.checks.some((check) => check !== group.build && requiresWholeProjectCheck(check)) &&
    group.evidence.sessions.every(
      (session) =>
        session.directory === group.session.directory || session.checks.every((check) => check.role === "setup"),
    )
  )
    return { scope, backend: isolation.backend };
  return {
    backend: undefined,
    scope: {
      mode: "whole-project" as const,
      paths: scope.paths,
      reason: missingModules
        ? "The scoped check requires prepared dependencies"
        : "Scoped execution is unavailable for these checks",
    },
  };
}

export function freshSecurityChecks(checks: readonly ConfiguredCheck[]): ConfiguredCheck[] {
  const needsSetup = checks.some((check) => check.role === "secret" && check.requiresSetup);
  return checks.filter((check) => check.role === "secret" || (needsSetup && check.role === "setup"));
}

/** A result receipt does not supply the live setup and outputs required by fresh work. */
export function freshCheckSessions(plan: CheckPlan, groups: readonly Group[], hits: readonly boolean[]): Session[] {
  const selected = plan.sessions.map(() => new Set<ConfiguredCheck>());
  for (const [position, group] of groups.entries()) {
    if (hits[position]) continue;
    const local = required(selected[group.index], "Missing check group selection");
    for (const check of group.session.checks) local.add(check);
    for (const build of group.builds) local.add(build);
    if ([...group.session.checks, ...group.builds].some((check) => check.role !== "setup" && check.requiresSetup)) {
      const session = required(plan.sessions[group.index], "Missing check session");
      for (const check of forPhase(session, "setup")) local.add(check);
    }
    for (const [predecessor, phase] of group.prerequisites)
      for (const check of forPhase(required(plan.sessions[predecessor], "Missing check prerequisite"), phase))
        selected[predecessor]?.add(check);
  }
  return plan.sessions.flatMap((session, index) => {
    const checks = session.checks.filter((check) => selected[index]?.has(check));
    return checks.length ? [{ ...session, checks }] : [];
  });
}
