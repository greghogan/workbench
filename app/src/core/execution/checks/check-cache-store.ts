import { readBoundedFile } from "../../runtime/file-reads.js";
import {
  CheckState,
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  writeDiagnosticText,
} from "../../diagnostics/diagnostics.mjs";
import { createHash } from "node:crypto";
import { measureCheckPhase, type CheckPhaseObserver, type CheckRunResult } from "./check-report.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
  buildCheckout,
  latestCheckResult,
  buildStorageRoots,
  buildStorageSettings,
  readBuildGeneration,
  type BuildIdentity,
} from "../../artifacts/builds.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { safeConfigurationDigests, safeEnvironmentDigests, type CheckFingerprint } from "./check-inputs.js";
import { ownedPath } from "../../runtime/paths.js";
import { withCacheLocksSync, withCacheLockSync } from "../../storage/cache-lock.js";
import type { CheckSelection, planChecks } from "./check-plan.js";
import {
  recordResultToolBatch,
  selectedToolRequirements,
  type ResultToolReference,
} from "../../toolchains/tool-references.js";
import { withToolCacheAdmission } from "../../toolchains/tool-cache-lock.js";

type Plan = ReturnType<typeof planChecks>;
interface Success {
  version: 2;
  key: string;
  completed: string;
  checks: number;
  components: CheckFingerprint["components"];
  environmentVariables?: CheckFingerprint["environmentVariables"];
  configurationFiles?: CheckFingerprint["configurationFiles"];
  reportSHA256: string;
}

const maximumResultBytes = 64 * 1024;
const maximumReportBytes = 64 * 1024 * 1024;
const reportDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function previousInputs(
  storageRoot: string,
  directory: string,
  identity: BuildIdentity,
): CheckFingerprint | undefined {
  const parent = join(directory, "..");
  try {
    const name = readBoundedFile(ownedPath(parent, latestCheckResult), 64, "latest check result").toString("utf8");
    if (!/^native-[0-9a-f]{24}$/.test(name) || join(parent, name) === directory) return;
    const candidate = ownedPath(parent, name);
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
      return undefined;
    return {
      key: saved.key,
      components: saved.components,
      environmentVariables: safeEnvironmentDigests(saved.environmentVariables),
      configurationFiles: safeConfigurationDigests(saved.configurationFiles),
    };
  } catch {
    // An unavailable diagnostic baseline never affects check reuse.
    return undefined;
  }
}

export function openCheckReceipt(
  root: string,
  options: CheckSelection,
  plan: Plan,
  inputs: CheckFingerprint,
  scope = ".",
) {
  const key = inputs.key;
  const storageRoot = buildStorageSettings(root).root;
  const identity: BuildIdentity = {
    checkout: process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? buildCheckout(root),
    root: scope,
    environment: "native",
    fingerprint: key.slice(0, 24),
  };
  const directory = join(buildStorageRoots(storageRoot, identity).checkRoots, `native-${identity.fingerprint}`);
  try {
    ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
  } catch (error) {
    writeDiagnosticText(`Check cache ownership unavailable; running fresh: ${String(error)}`);
    return undefined;
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
  const hit =
    options.cache !== false &&
    saved?.version === 2 &&
    savedReport &&
    saved.key === key &&
    saved.checks === count &&
    typeof saved.completed === "string" &&
    Number.isFinite(Date.parse(saved.completed))
      ? { report: savedReport, completed: saved.completed }
      : undefined;
  const invalidate = () => {
    if (validDirectory && existsSync(receipt))
      withCacheLockSync(directory, () => {
        readBuildGeneration(storageRoot, directory, "checks", identity);
        rmSync(ownedPath(directory, "result.json"), { force: true });
      });
  };
  const prepare = (report: CheckRunResult): PreparedCheckReceipt | undefined => {
    if (!validDirectory) return;
    const detailed = JSON.stringify(report);
    if (Buffer.byteLength(detailed) > maximumReportBytes) throw new Error("check report exceeds cache size limit");
    const paths = [
      ...new Set(plan.sessions.map((session) => relative(root, session.directory).split(sep).join("/") || ".")),
    ];
    return {
      reference: {
        directory,
        storageRoot,
        identity,
        kind: "checks",
        tools: selectedToolRequirements(root, paths, options),
      },
      latest: ownedPath(join(directory, ".."), latestCheckResult),
      detailed,
      result: {
        version: 2,
        key,
        checks: count,
        completed: new Date().toISOString(),
        components: inputs.components,
        environmentVariables: inputs.environmentVariables,
        configurationFiles: inputs.configurationFiles,
        reportSHA256: reportDigest(detailed),
      },
    };
  };
  return { storageRoot, directory, identity, receipt, hit, invalidate, prepare };
}

export interface PreparedCheckReceipt {
  reference: ResultToolReference;
  latest: string;
  detailed: string;
  result: Success;
}

/** Reuse relies on current inputs, while a wholly fresh result can pass without a receipt. */
export async function revalidateCheckResults<T>(
  acquire: () => Promise<T>,
  options: { reused: boolean; signal: AbortSignal | undefined; observe: CheckPhaseObserver | undefined },
): Promise<T | undefined> {
  try {
    const result = await measureCheckPhase("Check result revalidation", acquire, options.observe);
    await nextTurn();
    options.signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (options.reused || options.signal?.aborted) throw error;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.CheckCache,
      DiagnosticOutcome.Unavailable,
      {},
      error,
      "checks passed; successful evidence could not be cached",
    );
    return undefined;
  }
}

/** Install tool protection once, before making any finished receipt visible. */
export function saveCheckReceipts(receipts: readonly PreparedCheckReceipt[]): void {
  if (!receipts.length) return;
  const locks = [...new Set(receipts.flatMap(({ reference, latest }) => [reference.directory, latest]))].sort();
  withToolCacheAdmission(() => {
    withCacheLocksSync(locks, () => {
      for (const {
        reference: { directory, storageRoot, identity },
      } of receipts) {
        ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
        if (existsSync(directory)) readBuildGeneration(storageRoot, directory, "checks", identity);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeAtomic(ownedPath(directory, ".workbench-check-result.json"), JSON.stringify(identity), 0o600);
      }
      recordResultToolBatch(
        receipts.map(({ reference }) => reference),
        true,
      );
      for (const {
        reference: { directory },
        latest,
        detailed,
        result,
      } of receipts) {
        writeAtomic(ownedPath(directory, "run.json"), detailed, 0o600);
        writeAtomic(ownedPath(directory, "result.json"), JSON.stringify(result), 0o600);
        writeAtomic(latest, basename(directory), 0o600);
      }
    });
  });
}
