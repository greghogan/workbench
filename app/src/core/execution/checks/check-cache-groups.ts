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
import {
  openCheckReceipt,
  revalidateCheckResults,
  saveCheckReceipts,
  type PreparedCheckReceipt,
} from "./check-cache-store.js";
import { changedRunInputs, inputDigest, type checkFingerprintBatch, type CheckFingerprint } from "./check-inputs.js";
import { checkBackendName, type CheckIsolationBackend } from "./check-isolation.js";
import type { CheckPlan, CheckSelection } from "./check-plan.js";
import {
  type CheckCacheReport,
  type CheckGateRunner,
  type CheckPhaseObserver,
  type CheckRunResult,
} from "./check-report.js";
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
  inputs: {
    before: () => ReturnType<typeof checkFingerprintBatch>;
    after: () => ReturnType<typeof checkFingerprintBatch>;
    observe: CheckPhaseObserver | undefined;
    admit: ((selected: CheckPlan) => void) | undefined;
  },
  run: CheckGateRunner,
  signal?: AbortSignal,
  recordReport?: (report: CheckRunResult) => void,
  isolation?: { backend: CheckIsolationBackend | undefined },
  freshOnly = false,
): Promise<void> {
  const batch = inputs.before();
  const hasBuildOutputs = (group: Groups[number]) => group.build !== undefined || group.builds.length > 0;
  const observe = async (group: Groups[number], { scope, backend }: ReturnType<typeof checkGroupExecution>) => {
    signal?.throwIfAborted();
    let inputs: CheckFingerprint | undefined;
    let captured: Awaited<ReturnType<typeof batch.isolation>> | undefined;
    if (group.reusable) {
      try {
        if (!freshOnly || (backend && hasBuildOutputs(group))) {
          inputs = await batch.fingerprint(group.evidence, scope);
          if (backend && inputs.scopedSource) inputs.key = inputDigest([inputs.key, backend.identity]);
        } else if (backend) {
          captured = await batch.isolation(group.evidence, scope);
        }
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
    return { group, inputs, captured, scope, backend };
  };
  const observations: Awaited<ReturnType<typeof observe>>[] = [];
  for (const group of groups) observations.push(await observe(group, checkGroupExecution(root, group, isolation)));
  const buildFallback = new Set(
    observations.flatMap(({ group, backend, inputs }) =>
      hasBuildOutputs(group) && (!backend || !inputs?.scopedSource) ? [group.index] : [],
    ),
  );
  for (const [index, { group, backend, scope }] of observations.entries())
    if (hasBuildOutputs(group) && backend && buildFallback.has(group.index)) {
      observations[index] = await observe(group, {
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
  inputs.admit?.({ ...plan, sessions: fresh });
  const freshChecks = new Set(fresh.flatMap((session) => session.checks));
  const scopeFor = ({ group, inputs, captured, scope, backend }: (typeof observations)[number]) => ({
    path: group.path,
    environment: group.session.environment,
    checks: group.session.checks.map((check) => check.name),
    ...(backend && (inputs?.scopedSource || captured?.scopedSource) ? { backend: checkBackendName(backend) } : {}),
    inputScope:
      inputs?.inputScope ??
      captured?.inputScope ??
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
  const isolated = observations.flatMap(({ group, inputs, captured, backend }) => {
    const source = inputs ?? captured;
    const checks = group.session.checks.filter((check) => freshChecks.has(check)).map((check) => check.name);
    if (!checks.length || !backend || source?.inputScope?.mode !== "scoped" || !source.scopedSource) return [];
    const coveragePath =
      group.path === "." ? "coverage/coverage-summary.json" : group.path + "/coverage/coverage-summary.json";
    return [
      {
        directory: group.session.directory,
        group: {
          checks,
          outputs: source.inputScope.outputs ?? [],
          source: source.scopedSource,
          backend,
          ...(group.session.checks.some((check) => check.role === "coverage" || check.role === "test")
            ? { coverage: { contents: source.coverageBaselines?.[coveragePath] ?? null } }
            : {}),
          ...(group.session.checks.some((check) => check.role === "coverage") ? { instrumented: true } : {}),
          setup: group.setup,
          ...(group.preparedSetup ? { preparedSetup: group.preparedSetup } : {}),
          ...(group.builds.length ? { requiresBuild: group.builds.map(({ name }) => name) } : {}),
          ...(inputs && group.build?.inputs?.outputs?.length
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
  if (freshOnly) return;
  const revalidated = await revalidateCheckResults(
    async () => {
      const current = inputs.after();
      for (const { group, inputs, scope, backend } of observations) {
        if (!inputs) continue;
        signal?.throwIfAborted();
        const next = await current.revalidate(group.evidence, scope);
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
      return true;
    },
    { reused: reused > 0, signal, observe: inputs.observe },
  );
  if (!revalidated) return;
  const receipts: PreparedCheckReceipt[] = [];
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
      const receipt = entry.prepare({
        ...selected,
        cache: { outcome: "fresh", inputScope: scope.inputScope, groups: [scope] },
      });
      if (receipt) receipts.push(receipt);
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
  try {
    saveCheckReceipts(receipts);
  } catch (error) {
    diagnostic(LogLevel.Warn, DiagnosticOperation.CheckCache, DiagnosticOutcome.Unavailable, {}, error);
  }
}
