import { readBoundedFile } from "./file-reads.js";
import {
  CheckState,
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  writeDiagnosticText,
} from "./diagnostics.js";
import { createHash } from "node:crypto";
import type { CheckRunResult } from "./check-report.js";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  buildCheckout,
  buildStorageRoots,
  buildStorageSettings,
  readBuildGeneration,
  type BuildIdentity,
} from "./builds.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import {
  checkFingerprint,
  changedCheckInputs,
  changedEnvironmentVariables,
  safeEnvironmentDigests,
  type CheckFingerprint,
} from "./check-inputs.js";
import { ownedPath } from "./paths.js";
import { withCacheLockSync } from "./cache-lock.js";
import type { CheckSelection, planChecks } from "./check-plan.js";
import { recordResultTools, selectedToolRequirements } from "./tool-references.js";
import { NativeToolUnavailable } from "./tool-probes.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";

type Plan = ReturnType<typeof planChecks>;
interface Success {
  version: 2;
  key: string;
  completed: string;
  checks: number;
  components: CheckFingerprint["components"];
  environmentVariables?: CheckFingerprint["environmentVariables"];
  reportSHA256: string;
}

const maximumResultBytes = 64 * 1024;
const maximumReportBytes = 64 * 1024 * 1024;
const reportDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function previousInputs(storageRoot: string, directory: string, identity: BuildIdentity): CheckFingerprint | undefined {
  const parent = join(directory, "..");
  if (!existsSync(parent)) return undefined;
  let latest: { completed: string; inputs: CheckFingerprint } | undefined;
  for (const name of readdirSync(parent)) {
    if (!/^native-[0-9a-f]{24}$/.test(name) || join(parent, name) === directory) continue;
    const candidate = ownedPath(parent, name);
    try {
      readBuildGeneration(storageRoot, candidate, "checks", { ...identity, fingerprint: name.slice(7) });
      const path = ownedPath(candidate, "result.json");
      const saved = JSON.parse(
        readBoundedFile(path, maximumResultBytes, "check result").toString("utf8"),
      ) as Partial<Success>;
      if (
        saved.version !== 2 ||
        typeof saved.key !== "string" ||
        !/^[0-9a-f]{64}$/.test(saved.key) ||
        typeof saved.completed !== "string" ||
        !saved.components ||
        Object.entries(saved.components).some(
          ([key, value]) =>
            !["source", "checks", "environment", "host", "distribution", "tools", "allocation", "preferences"].includes(
              key,
            ) ||
            typeof value !== "string" ||
            !/^[0-9a-f]{64}$/.test(value),
        ) ||
        !Number.isFinite(Date.parse(saved.completed))
      )
        continue;
      if (!latest || latest.completed < saved.completed)
        latest = {
          completed: saved.completed,
          inputs: {
            key: saved.key,
            components: saved.components,
            environmentVariables: safeEnvironmentDigests(saved.environmentVariables),
          },
        };
    } catch {
      /* Unknown or damaged results provide no diagnostic baseline. */
    }
  }
  return latest?.inputs;
}

/** Reuse evidence, not build outputs. Human approval and structural validation remain independent. */
export async function withCachedChecks(
  root: string,
  options: CheckSelection,
  plan: Plan,
  run: (selected: Plan) => Promise<CheckRunResult>,
  signal?: AbortSignal,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  signal?.throwIfAborted();
  if (
    options.role?.length ||
    options.excludeRole?.length ||
    options.checkNames ||
    options.stage === "ci" ||
    plan.cleanup ||
    plan.sessions.some((session) => session.checks.some((check) => check.role === "advisory")) ||
    !plan.sessions.length ||
    [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(
      (value) => value && value !== "false" && value !== "0",
    )
  ) {
    await run(plan);
    return;
  }
  const verbose = options.verbose ?? process.env.WORKBENCH_VERBOSE === "1";
  const started = performance.now();
  let inputs: CheckFingerprint;
  try {
    inputs = checkFingerprint(root, options, plan);
  } catch (error) {
    if (error instanceof NativeToolUnavailable) throw error;
    diagnostic(LogLevel.Warn, DiagnosticOperation.CheckCache, DiagnosticOutcome.Unavailable, {}, error);
    writeDiagnosticText(
      `Check cache unavailable; running fresh: ${error instanceof Error ? error.message : String(error)}`,
    );
    await run(plan);
    return;
  }
  const key = inputs.key;
  const storageRoot = buildStorageSettings(root).root;
  const identity: BuildIdentity = {
    checkout: process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? buildCheckout(root),
    root: ".",
    environment: "native",
    fingerprint: key.slice(0, 24),
  };
  const directory = join(buildStorageRoots(storageRoot, identity).checkRoots, `native-${identity.fingerprint}`);
  try {
    ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
  } catch (error) {
    writeDiagnosticText(`Check cache ownership unavailable; running fresh: ${String(error)}`);
    await run(plan);
    return;
  }
  const receipt = ownedPath(directory, "result.json");
  const count = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  let validDirectory = true;
  let saved: Partial<Success> | null = null;
  let savedReport: CheckRunResult | undefined;
  if (existsSync(directory)) {
    try {
      readBuildGeneration(storageRoot, directory, "checks", identity);
      saved = JSON.parse(
        readBoundedFile(receipt, maximumResultBytes, "check result").toString("utf8"),
      ) as Partial<Success> | null;
      if (options.cache !== false && saved?.version === 2 && typeof saved.reportSHA256 === "string") {
        const bytes = readBoundedFile(ownedPath(directory, "run.json"), maximumReportBytes, "cached check report");
        if (reportDigest(bytes) !== saved.reportSHA256) throw new Error("cached check report checksum mismatch");
        const report = JSON.parse(bytes.toString("utf8")) as Partial<CheckRunResult> | null;
        if (
          report?.version !== 1 ||
          report.kind !== "workbench-check-run" ||
          typeof report.id !== "string" ||
          typeof report.started !== "string" ||
          typeof report.finished !== "string" ||
          !Number.isFinite(Date.parse(report.finished)) ||
          report.status !== CheckState.Passed ||
          !Array.isArray(report.checks) ||
          report.checks.length !== saved.checks ||
          report.checks.some((check) => check.status !== CheckState.Passed) ||
          !Array.isArray(report.groups) ||
          report.groups.length !== plan.sessions.length ||
          !Array.isArray(report.logIssues)
        )
          throw new Error("invalid cached check report");
        savedReport = report as CheckRunResult;
      }
    } catch {
      // A damaged result is a miss. Preserve directories with uncertain ownership.
      try {
        readBuildGeneration(storageRoot, directory, "checks", identity);
      } catch {
        validDirectory = false;
      }
    }
  }
  if (
    options.cache !== false &&
    saved?.version === 2 &&
    savedReport &&
    saved.key === key &&
    saved.checks === count &&
    typeof saved.completed === "string" &&
    Number.isFinite(Date.parse(saved.completed))
  ) {
    if (verbose)
      writeDiagnosticText(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s; ${receipt}`);
    const fresh: Plan = {
      ...plan,
      sessions: plan.sessions.flatMap((session) => {
        if (!session.checks.some((check) => check.role === "secret")) return [];
        const requiresSetup = session.checks.some((check) => check.role === "secret" && check.requiresSetup);
        return [
          {
            ...session,
            checks: session.checks.filter(
              (check) => check.role === "secret" || (check.role === "setup" && requiresSetup),
            ),
          },
        ];
      }),
    };
    const refreshed = fresh.sessions.reduce((sum, session) => sum + session.checks.length, 0);
    const refreshedChecks = new Set(fresh.sessions.flatMap((session) => session.checks));
    const checks = plan.sessions.flatMap((session) => session.checks);
    const reused = savedReport.checks.filter((_, index) => {
      const check = checks[index];
      return check !== undefined && !refreshedChecks.has(check);
    });
    if (reused.length)
      recordReport?.({
        ...savedReport,
        reused: { verified: saved.completed },
        checks: reused,
        groups: savedReport.groups.filter((_, index) =>
          plan.sessions[index]?.checks.some((check) => !refreshedChecks.has(check)),
        ),
      });
    diagnostic(LogLevel.Debug, DiagnosticOperation.CheckCache, DiagnosticOutcome.Reused, {
      reusedChecks: count - refreshed,
      freshChecks: refreshed,
      elapsedMs: performance.now() - started,
    });
    if (refreshed) {
      writeDiagnosticText(
        `Cached evidence matches ${String(count - refreshed)}/${String(count)} checks; refreshing ${String(refreshed)} setup and security checks.`,
      );
      await run(fresh);
      if (key !== checkFingerprint(root, options, plan).key)
        throw new Error("check inputs changed while refreshing security checks; rerun checks");
    }
    await nextTurn();
    signal?.throwIfAborted();
    writeDiagnosticText(
      refreshed
        ? `Reused ${String(count - refreshed)}/${String(count)} checks (verified ${saved.completed}); ${String(refreshed)} setup and security checks ran fresh. Use --no-cache to rerun all checks.`
        : `Reused successful gate: ${String(count)}/${String(count)} checks (verified ${saved.completed}). Use --no-cache to rerun.`,
    );
    return;
  }
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
  if (verbose) writeDiagnosticText(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s.`);
  const invalidate = () => {
    if (validDirectory && existsSync(receipt))
      withCacheLockSync(directory, () => {
        readBuildGeneration(storageRoot, directory, "checks", identity);
        rmSync(ownedPath(directory, "result.json"), { force: true });
      });
  };
  // A failed or interrupted fresh run must not leave earlier success evidence usable.
  invalidate();
  let report: CheckRunResult;
  try {
    report = await run(plan);
  } catch (error) {
    try {
      invalidate();
    } catch (cleanup) {
      console.warn(`Could not invalidate check evidence: ${String(cleanup)}`);
    }
    throw error;
  }
  if (!validDirectory) return;
  try {
    const current = checkFingerprint(root, options, plan);
    if (key !== current.key) {
      writeDiagnosticText(
        `Checks passed; inputs changed during execution (${changedCheckInputs(inputs, current).join(", ")}), so this result was not cached.`,
      );
      return;
    }
    const selectedPaths = new Set(
      plan.sessions.map((session) => relative(root, session.directory).split(sep).join("/") || "."),
    );
    const tools = selectedToolRequirements(root, [...selectedPaths], options);
    const detailed = JSON.stringify(report);
    if (Buffer.byteLength(detailed) > maximumReportBytes) throw new Error("check report exceeds cache size limit");
    await nextTurn();
    signal?.throwIfAborted();
    withToolCacheAdmission(() => {
      withCacheLockSync(directory, () => {
        ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
        if (existsSync(directory)) readBuildGeneration(storageRoot, directory, "checks", identity);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeAtomic(ownedPath(directory, ".workbench-check-result.json"), JSON.stringify(identity), 0o600);
        recordResultTools({ directory, storageRoot, identity, kind: "checks", tools }, true);
        writeAtomic(ownedPath(directory, "run.json"), detailed, 0o600);
        const saved: Success = {
          version: 2,
          key,
          checks: count,
          completed: new Date().toISOString(),
          components: inputs.components,
          environmentVariables: inputs.environmentVariables,
          reportSHA256: reportDigest(detailed),
        };
        writeAtomic(ownedPath(directory, "result.json"), JSON.stringify(saved), 0o600);
      });
    });
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
