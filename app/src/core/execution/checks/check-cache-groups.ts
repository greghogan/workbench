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
import { buildPaths } from "../../artifacts/builds.js";
import { NativeToolUnavailable } from "../../toolchains/tool-probes.js";
import { checkGroupExecution, freshCheckSessions, scopedCheckGroups } from "./check-cache-plan.js";
import { openCheckReceipt } from "./check-cache-store.js";
import { changedRunInputs, checkFingerprintBatch, inputDigest, type CheckFingerprint } from "./check-inputs.js";
import { checkBackendName, type CheckIsolationBackend } from "./check-isolation.js";
import type { CheckPlan, CheckSelection } from "./check-plan.js";
import type { CheckCacheReport, CheckGateRunner, CheckRunResult } from "./check-report.js";
import { checkBuildProductIdentity } from "./check-build-products.js";

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
  isolation?: { backend: CheckIsolationBackend | undefined },
  freshOnly = false,
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
  const observe = (group: Groups[number], { scope, backend }: ReturnType<typeof checkGroupExecution>) => {
    let inputs: CheckFingerprint | undefined;
    if (group.reusable) {
      try {
        inputs = batch.fingerprint(group.evidence, scope);
        if (backend && inputs.scopedSource) inputs.key = inputDigest([inputs.key, backend.identity]);
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
    return { group, inputs, scope, backend };
  };
  const observations = groups.map((group) => observe(group, checkGroupExecution(root, group, isolation)));
  const hasBuildOutputs = (group: Groups[number]) => group.build !== undefined || group.builds.length > 0;
  const buildFallback = new Set(
    observations.flatMap(({ group, backend, inputs }) =>
      hasBuildOutputs(group) && (!backend || !inputs?.scopedSource) ? [group.index] : [],
    ),
  );
  for (const [index, { group, backend, scope }] of observations.entries())
    if (hasBuildOutputs(group) && backend && buildFallback.has(group.index)) {
      observations[index] = observe(group, {
        backend: undefined,
        scope: {
          mode: "whole-project",
          ...(scope.paths ? { paths: scope.paths } : {}),
          reason: "Build and consumer need a shared execution scope",
        },
      });
    }
  const builders = new Map(
    observations.flatMap((observation) =>
      observation.group.build ? [[observation.group.build.name, observation] as const] : [],
    ),
  );
  const directories = new Map<number, string>();
  const savedProducts = new Map<string, string | undefined>();
  const receiptFor = (
    { group, inputs, backend }: (typeof observations)[number],
    executedProducts?: ReadonlyMap<string, string>,
  ) => {
    if (!inputs || freshOnly) return undefined;
    let receiptInputs = inputs;
    if (backend && group.builds.length) {
      let directory = directories.get(group.index);
      if (!directory) {
        directory = buildPaths(root, group.session.directory, "native", options).directory;
        directories.set(group.index, directory);
      }
      const identities = group.builds.map(({ name }) => {
        const key = builders.get(name)?.inputs?.key;
        if (!key) return undefined;
        if (executedProducts) return executedProducts.get(key);
        if (!savedProducts.has(key)) savedProducts.set(key, checkBuildProductIdentity(directory, key));
        return savedProducts.get(key);
      });
      if (identities.some((identity) => identity === undefined)) return undefined;
      receiptInputs = { ...inputs, key: inputDigest([inputs.key, identities]) };
    }
    return openCheckReceipt(root, options, { ...plan, sessions: [group.session] }, receiptInputs, group.path);
  };
  const entries = observations.map((observation) => receiptFor(observation));
  const fresh = freshCheckSessions(
    plan,
    groups,
    entries.map((entry) => !!entry?.hit),
  );
  const freshChecks = new Set(fresh.flatMap((session) => session.checks));
  const scopeFor = ({ group, inputs, scope, backend }: (typeof observations)[number]) => ({
    path: group.path,
    environment: group.session.environment,
    checks: group.session.checks.map((check) => check.name),
    ...(backend && inputs?.scopedSource ? { backend: checkBackendName(backend) } : {}),
    inputScope:
      inputs?.inputScope ??
      (group.reusable && scope.mode === "scoped"
        ? { mode: "whole-project" as const, reason: "Group inputs could not be verified" }
        : scope),
  });
  let reused = 0;
  for (const [index, observation] of observations.entries()) {
    const { group } = observation;
    const entry = entries[index];
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
  const isolated = observations.flatMap(({ group, inputs, backend }) => {
    const checks = group.session.checks.filter((check) => freshChecks.has(check)).map((check) => check.name);
    if (!checks.length || !backend || inputs?.inputScope?.mode !== "scoped" || !inputs.scopedSource) return [];
    const coveragePath =
      group.path === "." ? "coverage/coverage-summary.json" : group.path + "/coverage/coverage-summary.json";
    return [
      {
        directory: group.session.directory,
        group: {
          checks,
          paths: inputs.inputScope.paths,
          outputs: inputs.inputScope.outputs ?? [],
          sourceDigest: inputDigest(inputs.scopedSource),
          backend,
          ...(group.session.checks.some((check) => check.role === "coverage" || check.role === "test")
            ? { coverage: { path: coveragePath, digest: inputs.coverageBaselines?.[coveragePath] ?? null } }
            : {}),
          setup: group.setup,
          ...(group.builds.length ? { requiresBuild: group.builds.map(({ name }) => name) } : {}),
          ...(group.build?.inputs?.outputs?.length
            ? {
                build: {
                  name: group.build.name,
                  outputs: group.build.inputs.outputs,
                  key: inputs.key,
                  reuse: options.cache !== false && !freshOnly,
                },
              }
            : {}),
        },
      },
    ];
  });
  const freshPlan = { ...plan, sessions: fresh, resourceSessions: plan.sessions.length, isolated };
  const executedProducts = new Map<string, string>();
  const report = await run(freshPlan, cache, executedProducts);
  if (freshOnly && !security) return;
  try {
    const current = checkFingerprintBatch(root, options);
    if (security && current.freshSource() !== wholeSource)
      throw new Error("check inputs changed during execution; rerun checks (source changed during the security scan)");
    for (const { group, inputs, scope, backend } of observations) {
      if (!inputs) continue;
      const next = current.fingerprint(group.evidence, scope);
      const key = backend && next.scopedSource ? inputDigest([next.key, backend.identity]) : next.key;
      if (backend && !group.session.checks.some((check) => freshChecks.has(check)))
        for (const build of group.builds) {
          const buildKey = builders.get(build.name)?.inputs?.key;
          if (buildKey && freshChecks.has(build) && savedProducts.get(buildKey) !== executedProducts.get(buildKey))
            throw new Error(`Prerequisite outputs from '${build.name}' changed while checking; rerun the gate`);
        }
      if (key === inputs.key) continue;
      const changed = changedRunInputs(inputs, next);
      throw new Error(
        `check inputs changed during execution; rerun checks (${changed.join(", ") || "input scope"} in ${group.path})`,
      );
    }
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
    const { group } = observation;
    if (!group.session.checks.some((check) => freshChecks.has(check))) continue;
    const entry = receiptFor(observation, executedProducts);
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
