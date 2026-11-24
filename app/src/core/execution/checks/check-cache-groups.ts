import { setImmediate as nextTurn } from "node:timers/promises";
import {
  CheckState,
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  writeDiagnosticText,
} from "../../diagnostics/diagnostics.mjs";
import { required } from "../../runtime/invariants.js";
import { NativeToolUnavailable } from "../../toolchains/tool-probes.js";
import { freshCheckSessions, scopedCheckGroups } from "./check-cache-plan.js";
import { openCheckReceipt } from "./check-cache-store.js";
import { checkFingerprintBatch, type CheckFingerprint } from "./check-inputs.js";
import type { CheckPlan, CheckSelection } from "./check-plan.js";
import type { CheckCacheReport, CheckGateRunner, CheckRunResult } from "./check-report.js";

type Groups = NonNullable<ReturnType<typeof scopedCheckGroups>>;

function selectReport(report: CheckRunResult, session: CheckPlan["sessions"][number]): CheckRunResult {
  const matches = (entry: { root: string; environment: string }) =>
    entry.root === session.directory && entry.environment === session.environment;
  const checks = new Set(session.checks.map((check) => check.name));
  return {
    ...report,
    checks: report.checks.filter((check) => matches(check) && checks.has(check.name)),
    groups: report.groups.filter(matches),
  };
}

export async function withScopedCheckGroups(
  root: string,
  options: CheckSelection,
  plan: CheckPlan,
  groups: Groups,
  run: CheckGateRunner,
  signal?: AbortSignal,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  const batch = checkFingerprintBatch(root, options);
  const security = plan.sessions.some((session) => session.checks.some((check) => check.role === "secret"));
  let wholeSource: string | undefined;
  try {
    if (security) wholeSource = batch.freshSource();
  } catch (error) {
    writeDiagnosticText("Check cache unavailable; could not identify the source for fresh security checks.");
    diagnostic(LogLevel.Warn, DiagnosticOperation.CheckCache, DiagnosticOutcome.Unavailable, {}, error);
    await run(plan, {
      outcome: "fresh",
      inputScope: { mode: "whole-project", reason: "Security inputs could not be inventoried safely" },
    });
    return;
  }
  const observations = groups.map((group) => {
    let inputs: CheckFingerprint | undefined;
    let entry: ReturnType<typeof openCheckReceipt>;
    if (group.reusable) {
      try {
        inputs = batch.fingerprint(group.evidence, group.scope);
        entry = openCheckReceipt(root, options, { ...plan, sessions: [group.session] }, inputs, group.path);
      } catch (error) {
        if (error instanceof NativeToolUnavailable) throw error;
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.CheckCache,
          DiagnosticOutcome.Unavailable,
          { path: group.path },
          error,
        );
      }
    }
    return { group, inputs, entry };
  });
  const fresh = freshCheckSessions(
    plan,
    groups,
    observations.map(({ entry }) => !!entry?.hit),
  );
  const freshChecks = new Set(fresh.flatMap((session) => session.checks));
  const scopeFor = ({ group, inputs }: (typeof observations)[number]) => ({
    path: group.path,
    environment: group.session.environment,
    checks: group.session.checks.map((check) => check.name),
    inputScope:
      inputs?.inputScope ??
      (group.reusable ? { mode: "whole-project" as const, reason: "Group inputs could not be verified" } : group.scope),
  });
  let reused = 0;
  for (const observation of observations) {
    const { group, entry } = observation;
    if (!entry?.hit) {
      entry?.invalidate();
      continue;
    }
    const remaining = group.session.checks.filter((check) => !freshChecks.has(check));
    if (!remaining.length) continue;
    reused += remaining.length;
    const scope = scopeFor(observation);
    const names = new Set(remaining.map((check) => check.name));
    recordReport?.({
      ...entry.hit.report,
      checks: entry.hit.report.checks
        .filter((check) => names.has(check.name))
        .map((check) => ({ ...check, root: group.session.directory })),
      groups: entry.hit.report.groups.map((result) => ({ ...result, root: group.session.directory })),
      reused: { verified: entry.hit.completed },
      cache: { outcome: "reused", inputScope: scope.inputScope, groups: [scope] },
    });
  }
  if (reused)
    writeDiagnosticText(`Reusing ${String(reused)} successful checks; ${String(freshChecks.size)} run fresh.`);
  if (!fresh.length) {
    signal?.throwIfAborted();
    return;
  }
  const scopes = observations
    .filter(({ group }) => group.session.checks.some((check) => freshChecks.has(check)))
    .map(scopeFor);
  const cache: CheckCacheReport = {
    outcome: "fresh",
    inputScope:
      scopes.length === 1
        ? required(scopes[0], "Missing fresh check group").inputScope
        : { mode: "whole-project", reason: "See the individual check group scopes" },
    ...(options.cache === false ? { reason: "Fresh run requested" } : {}),
    groups: scopes,
  };
  const freshPlan = { ...plan, sessions: fresh, resourceSessions: plan.sessions.length };
  const report = await run(freshPlan, cache);
  try {
    const current = checkFingerprintBatch(root, options);
    if (
      (security && current.freshSource() !== wholeSource) ||
      observations.some(
        ({ group, inputs }) => inputs && current.fingerprint(group.evidence, group.scope).key !== inputs.key,
      )
    )
      throw new Error("check inputs changed during execution; rerun checks");
  } catch (error) {
    if (reused) throw error;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.CheckCache,
      DiagnosticOutcome.Unavailable,
      {},
      error,
      "checks passed; successful evidence could not be cached",
    );
    return;
  }
  await nextTurn();
  signal?.throwIfAborted();
  for (const observation of observations) {
    const { group, entry } = observation;
    if (!entry || entry.hit) continue;
    const scope = scopeFor(observation);
    const selected = selectReport(report, group.session);
    if (
      selected.status !== CheckState.Passed ||
      selected.checks.length !== group.session.checks.length ||
      selected.checks.some((check) => check.status !== CheckState.Passed)
    )
      continue;
    try {
      entry.save({ ...selected, cache: { outcome: "fresh", inputScope: scope.inputScope, groups: [scope] } });
    } catch (error) {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.CheckCache,
        DiagnosticOutcome.Unavailable,
        { path: group.path },
        error,
      );
    }
  }
}
