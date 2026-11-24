import { relative } from "node:path";
import { readConfig } from "../../projects/project-configuration.js";
import { required } from "../../runtime/invariants.js";
import type { ConfiguredCheck } from "./check-configuration.js";
import type { CheckDependency } from "./check-order.js";
import type { CheckPlan } from "./check-plan.js";
import { checkExecution } from "./check-resources.js";
import { checkScopes, reusableChecks } from "./check-input-scope.js";

type Session = CheckPlan["sessions"][number];
type Phase = CheckDependency["phase"];

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
    const key =
      check.role === "setup" || check.role === "secret" ? check.role : JSON.stringify(check.inputs?.groups ?? null);
    const partition = partitions.get(key);
    if (partition) partition.push(check);
    else partitions.set(key, [check]);
  }
  return [...partitions.values()];
}

export function scopedCheckGroups(root: string, plan: CheckPlan) {
  if (!plan.sessions.some((session) => reusableChecks(session.checks).some((check) => check.inputs))) return undefined;
  const partitions = plan.sessions.map(checkPartitions);
  if (
    partitions.length === 1 &&
    (partitions[0]?.filter((checks) => checks.some((check) => check.role !== "setup" && check.role !== "secret"))
      .length ?? 0) < 2
  )
    return undefined;
  const { dependencies } = checkExecution(root, plan);
  const additional = readConfig(root).checks?.inputs;
  return plan.sessions.flatMap((session, index) => {
    const needed = prerequisites(dependencies, index);
    const setup = forPhase(session, "setup");
    return (partitions[index] ?? []).map((checks) => {
      const reusable = checks.every((check) => check.role !== "secret");
      const local = checks.some((check) => check.role !== "setup" && check.requiresSetup)
        ? [...setup, ...checks]
        : checks;
      const evidence = plan.sessions.flatMap((candidate, position) => {
        const phase = needed.get(position);
        if (candidate === session) return [{ ...session, checks: local }];
        return phase ? [{ ...candidate, checks: forPhase(candidate, phase) }] : [];
      });
      const scope = checkScopes(
        evidence.flatMap((candidate) => candidate.checks.filter((check) => check.role !== "secret")),
        additional,
      );
      return {
        index,
        session: { ...session, checks },
        path: relative(root, session.directory).replaceAll("\\", "/") || ".",
        prerequisites: needed,
        scope,
        reusable,
        evidence: { ...plan, sessions: evidence, resourceSessions: plan.sessions.length },
      };
    });
  });
}

type Group = NonNullable<ReturnType<typeof scopedCheckGroups>>[number];

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
    if (group.session.checks.some((check) => check.role !== "setup" && check.requiresSetup)) {
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
