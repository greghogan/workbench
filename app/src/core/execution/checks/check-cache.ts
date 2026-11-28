import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  writeDiagnosticText,
} from "../../diagnostics/diagnostics.mjs";
import {
  measureCheckPhase,
  type CheckGateRunner,
  type CheckPhaseObserver,
  type CheckRunResult,
} from "./check-report.js";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  checkFingerprintBatch,
  changedCheckInputs,
  changedRunInputs,
  changedEnvironmentVariables,
  changedConfigurationFiles,
  type CheckFingerprint,
} from "./check-inputs.js";
import { openCheckReceipt, previousInputs, revalidateCheckResults, saveCheckReceipts } from "./check-cache-store.js";
import type { CheckPlan, CheckSelection } from "./check-plan.js";
import { NativeToolUnavailable } from "../../toolchains/tool-probes.js";
import { checkGateInputScope } from "./check-input-scope.js";
import { readConfig } from "../../projects/project-configuration.js";
import { freshSecurityChecks, scopedCheckGroups } from "./check-cache-plan.js";
import type { CheckIsolationBackend } from "./check-isolation.js";
import { checkStagedSourceUnchanged } from "./check-source-view.js";
import { withScopedCheckGroups } from "./check-cache-groups.js";
import { checkToolDigests } from "./check-tool-digests.js";

/** Reuse evidence, not build outputs. Human approval and structural validation remain independent. */
export async function withCachedChecks(
  root: string,
  options: CheckSelection,
  plan: CheckPlan,
  execute: CheckGateRunner,
  signal?: AbortSignal,
  recordReport?: (report: CheckRunResult) => void,
  isolation?: { backend: CheckIsolationBackend | undefined },
  observe?: CheckPhaseObserver,
  admit?: (selected: CheckPlan) => void,
): Promise<void> {
  signal?.throwIfAborted();
  type Observation = ReturnType<typeof checkFingerprintBatch>;
  let before: Observation | undefined;
  let after: Observation | undefined;
  const directories = plan.sessions.map(({ directory }) => directory);
  const stagedDigests = new Map<string, string>();
  const toolDigests = checkToolDigests();
  const inputsBefore = () => {
    before ??= checkFingerprintBatch(root, options, directories, stagedDigests, toolDigests);
    return before;
  };
  const inputsAfter = () => {
    after ??= checkFingerprintBatch(root, options, directories, stagedDigests, toolDigests);
    return after;
  };
  const start = new Date().toISOString();
  const preparation = performance.now();
  let announced = false;
  const prepared = () => {
    if (announced) return;
    announced = true;
    toolDigests.save();
    observe?.({
      name: "Check inputs and isolation plan",
      started: start,
      durationMs: performance.now() - preparation,
      status: "passed",
    });
  };
  const run: CheckGateRunner = async (selected, cache, products) => {
    admit?.(selected);
    const security = selected.sessions.some((session) => session.checks.some((check) => check.role === "secret"));
    const source = security ? await inputsBefore().freshSource() : undefined;
    prepared();
    const report = await execute(selected, cache, products);
    signal?.throwIfAborted();
    checkStagedSourceUnchanged(root);
    if (source === undefined) return report;
    await measureCheckPhase(
      "Security input revalidation",
      async () => {
        if ((await inputsAfter().freshSource()) !== source)
          throw new Error(
            "check inputs changed during execution (source changed during the security scan), so rerun checks",
          );
      },
      observe,
    );
    return report;
  };
  const declaredScope = checkGateInputScope(plan.sessions, readConfig(root).checks?.inputs);
  const runFresh = (reason: string, selected = plan, inputScope = declaredScope) =>
    run(selected, { outcome: "fresh", inputScope, reason });
  const ci =
    options.stage === "ci" ||
    [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(
      (value) => value && value !== "false" && value !== "0",
    );
  const freshOnly =
    (options.role?.length ?? 0) > 0 ||
    (options.excludeRole?.length ?? 0) > 0 ||
    options.checkNames !== undefined ||
    ci ||
    // Extended checks may probe host services and disposable environments outside the source fingerprint.
    plan.sessions.some((session) =>
      session.checks.some((check) => check.online || check.role === "advisory" || (options.extended && check.extended)),
    );
  const groups = scopedCheckGroups(root, plan, !!isolation);
  if (groups && (!freshOnly || isolation)) {
    await withScopedCheckGroups(
      root,
      options,
      plan,
      groups,
      { before: inputsBefore, after: inputsAfter, observe, admit },
      run,
      signal,
      recordReport,
      isolation,
      freshOnly,
    );
    prepared();
    return;
  }
  if (freshOnly || plan.cleanup || !plan.sessions.length) {
    const scope =
      declaredScope.mode === "scoped" && isolation
        ? { mode: "whole-project" as const, reason: "This selection has no verified isolation backend" }
        : declaredScope;
    await runFresh("Reuse is disabled for this selection", plan, scope);
    return;
  }
  const verbose = options.verbose ?? process.env.WORKBENCH_VERBOSE === "1";
  const started = performance.now();
  let inputs: CheckFingerprint;
  try {
    inputs = await inputsBefore().fingerprint(plan);
  } catch (error) {
    if (error instanceof NativeToolUnavailable) throw error;
    before = undefined;
    diagnostic(LogLevel.Warn, DiagnosticOperation.CheckCache, DiagnosticOutcome.Unavailable, {}, error);
    writeDiagnosticText(
      `Check cache unavailable; running fresh: ${error instanceof Error ? error.message : String(error)}`,
    );
    await runFresh("Check inputs could not be verified");
    return;
  }
  const inputScope = inputs.inputScope ?? declaredScope;
  const entry = openCheckReceipt(root, options, plan, inputs);
  if (!entry) {
    await runFresh("Cache ownership could not be verified", plan, inputScope);
    return;
  }
  const { storageRoot, directory, identity, receipt, hit, invalidate } = entry;
  const count = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  if (hit) {
    if (verbose)
      writeDiagnosticText(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s; ${receipt}`);
    const fresh: CheckPlan = {
      ...plan,
      sessions: plan.sessions.flatMap((session) => {
        const checks = freshSecurityChecks(session.checks);
        return checks.length ? [{ ...session, checks }] : [];
      }),
    };
    const refreshed = fresh.sessions.reduce((sum, session) => sum + session.checks.length, 0);
    admit?.(fresh);
    const refreshedChecks = new Set(fresh.sessions.flatMap((session) => session.checks));
    const checks = plan.sessions.flatMap((session) => session.checks);
    const reused = hit.report.checks.filter((_, index) => {
      const check = checks[index];
      return check !== undefined && !refreshedChecks.has(check);
    });
    if (reused.length)
      recordReport?.({
        ...hit.report,
        reused: { verified: hit.completed },
        cache: { outcome: "reused", inputScope },
        checks: reused,
        groups: hit.report.groups.filter((_, index) =>
          plan.sessions[index]?.checks.some((check) => !refreshedChecks.has(check)),
        ),
      });
    diagnostic(LogLevel.Debug, DiagnosticOperation.CheckCache, DiagnosticOutcome.Reused, {
      reusedChecks: count - refreshed,
      freshChecks: refreshed,
      elapsedMs: performance.now() - started,
    });
    if (!refreshed) prepared();
    if (refreshed) {
      writeDiagnosticText(
        `Cached evidence matches ${String(count - refreshed)}/${String(count)} checks; refreshing ${String(refreshed)} setup and security checks.`,
      );
      await runFresh("Security checks and required setup always run fresh", fresh, inputScope);
      const current = await revalidateCheckResults(() => inputsAfter().revalidate(plan), {
        reused: true,
        signal,
        observe,
      });
      if (current && (inputs.key !== current.key || inputs.freshSource !== current.freshSource)) {
        const changed = changedRunInputs(inputs, current);
        const variables = changedEnvironmentVariables(inputs, current);
        throw new Error(
          `check inputs changed while refreshing security checks (${changed.join(", ")}${variables.length ? "; variables: " + variables.join(", ") : ""}); rerun checks`,
        );
      }
    }
    await nextTurn();
    signal?.throwIfAborted();
    writeDiagnosticText(
      refreshed
        ? `Reused ${String(count - refreshed)}/${String(count)} checks (verified ${hit.completed}); ${String(refreshed)} setup and security checks ran fresh. Use --no-cache to rerun all checks.`
        : `Reused successful gate: ${String(count)}/${String(count)} checks (verified ${hit.completed}). Use --no-cache to rerun.`,
    );
    return;
  }
  admit?.(plan);
  const previous = options.cache === false ? undefined : previousInputs(storageRoot, directory, identity);
  const changed = previous ? changedCheckInputs(previous, inputs) : [];
  diagnostic(
    LogLevel.Debug,
    DiagnosticOperation.CheckCache,
    options.cache === false ? DiagnosticOutcome.Discarded : DiagnosticOutcome.Missing,
    { changedCategories: changed.join(", "), elapsedMs: performance.now() - started },
  );
  writeDiagnosticText(
    options.cache === false
      ? "Running fresh checks (--no-cache)."
      : `Check cache miss: ${changed.length ? `${changed.join(", ")} changed` : "no reusable successful result"}.`,
  );
  const variables = previous ? changedEnvironmentVariables(previous, inputs) : [];
  if (variables.length)
    writeDiagnosticText(
      `Changed environment variables: ${variables.slice(0, 12).join(", ")}${variables.length > 12 ? ` (and ${String(variables.length - 12)} more)` : ""}. Values are not shown.`,
    );
  const configuration = previous ? changedConfigurationFiles(previous, inputs) : [];
  if (configuration.length)
    writeDiagnosticText(
      `Changed configuration files: ${configuration.slice(0, 12).join(", ")}${configuration.length > 12 ? ` (and ${String(configuration.length - 12)} more)` : ""}. Contents are not shown.`,
    );
  if (verbose) writeDiagnosticText(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s.`);
  // A failed or interrupted fresh run must not leave earlier success evidence usable.
  invalidate();
  let report: CheckRunResult;
  try {
    report = await runFresh(
      options.cache === false ? "Fresh run requested" : changed.length ? `${changed.join(", ")} changed` : "Cache miss",
      plan,
      inputScope,
    );
  } catch (error) {
    try {
      invalidate();
    } catch (cleanup) {
      writeDiagnosticText(`Could not invalidate check evidence: ${String(cleanup)}`);
    }
    throw error;
  }
  try {
    const current = await revalidateCheckResults(() => inputsAfter().revalidate(plan), {
      reused: false,
      signal,
      observe,
    });
    if (!current) return;
    if (inputs.key !== current.key || inputs.freshSource !== current.freshSource) {
      writeDiagnosticText(
        `Checks passed; inputs changed during execution (${changedRunInputs(inputs, current).join(", ")}), so this result was not cached.`,
      );
      return;
    }
    const saved = entry.prepare(report);
    if (!saved) return;
    saveCheckReceipts([saved]);
    diagnostic(LogLevel.Debug, DiagnosticOperation.CheckCache, DiagnosticOutcome.Stored, { checks: count, receipt });
    if (verbose) writeDiagnosticText(`Saved successful gate: ${receipt}`);
  } catch (error) {
    if (signal?.aborted) throw error;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.CheckCache,
      DiagnosticOutcome.Unavailable,
      { checks: "passed" },
      error,
      "checks passed; successful evidence could not be cached",
    );
  }
}
