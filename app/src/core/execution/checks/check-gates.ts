import { readFileSync } from "node:fs";
import { checkArchivePublication } from "../../records/archive-publication.js";
import { verifyCIImages } from "../ci/ci-images.js";
import { checkAgentCommit, checkAgentPush } from "../../review/agent-review.js";
import { checkReview } from "../../review/review-check.js";
import { checkRecordRetention } from "../../records/record-retention.js";
import { resolve } from "node:path";
import {
  withCheckReport,
  writeCheckReport,
  measureCheckPhase,
  type CheckPhase,
  type CheckPhaseObserver,
  type CheckRunResult,
} from "./check-report.js";
import { inspectChecks, listChecks, runChecks, type CheckInspectionOptions } from "./checks.js";
import { validate } from "../../records/validation.js";
import { releaseAfterFailure } from "../../storage/cache-lock.js";
import { safeOutput } from "../../diagnostics/terminal-output.js";
import { CheckNetwork } from "./check-network.mjs";
import { provisionalCommitRequested } from "../../git/commit-history.js";
import { checkPushSignatures } from "../../git/push-signatures.js";
import { currentExecutionEnvironment } from "../environments/execution-context.js";

export interface GateOptions extends CheckInspectionOptions {
  list?: boolean;
  connectivityUrl?: string;
  remote?: string;
}

const gateHeadings = {
  check: undefined,
  "pre-commit": "Pre-commit checks",
  "pre-push": "Online pre-push checks",
};

const connectivityUrl = "https://api.osv.dev/";
const connectedOperations = new Set([
  "setup",
  "acquire",
  "advisory",
  "clean",
  "distclean",
  "release",
  "release-verify",
  "compatibility-setup",
  "compatibility-test",
  "integration",
]);
const unavailableCodes = new Set([
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function probeUrl(url: string): URL {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("connectivity URL must use HTTP or HTTPS without credentials");
  return parsed;
}

/** A response establishes connectivity, including HTTP errors; it does not establish check success. */
export async function onlineReachable(url: string = connectivityUrl): Promise<boolean> {
  const parsed = probeUrl(url);
  try {
    const response = await fetch(parsed, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const cause: unknown = error.cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    if (error.name !== "TimeoutError" && !unavailableCodes.has(code)) throw error;
    console.log(
      `Online checks skipped: connectivity to ${parsed.origin} could not be established (${code || error.name}).`,
    );
    return false;
  }
}

async function executeGate(
  root: string,
  mode: "check" | "pre-commit" | "pre-push",
  options: GateOptions,
  recordReport?: (report: CheckRunResult) => void,
  observe?: CheckPhaseObserver,
): Promise<void> {
  if (mode !== "check" && options.extended) throw new Error("--extended applies only to check");
  if (mode !== "check" && (options.role?.length || options.excludeRole?.length))
    throw new Error(
      "role selection applies only to check; commit and push gates require their complete configured checks",
    );
  const focused = (options.role?.length ?? 0) > 0 || (options.excludeRole?.length ?? 0) > 0;
  const prepared = options.offline ?? currentExecutionEnvironment().WORKBENCH_OFFLINE === "1";
  const combined = mode === "check" && !focused && !prepared && options.stage === undefined;
  const linuxOffline =
    process.platform === "linux" &&
    mode !== "pre-push" &&
    options.network !== CheckNetwork.Online &&
    !options.extended &&
    !options.role?.some((role) => connectedOperations.has(role));
  const offline = prepared || linuxOffline;
  if (offline) {
    if (mode === "pre-push" || options.network === CheckNetwork.Online)
      throw new Error("Required online checks need a connected environment");
    if (process.platform === "win32") throw new Error("Offline check execution is unavailable on Windows");
    if (
      mode === "pre-commit" &&
      inspectChecks(root, { ...options, network: CheckNetwork.All }).selected.some((check) => check.online)
    )
      throw new Error("The configured commit gate requires online checks. Run it in a connected environment");
    options = { ...options, offline: true, network: CheckNetwork.Offline };
  }
  const online = {
    ...options,
    offline: false,
    network: CheckNetwork.Online,
    stage: "ci",
    cache: false,
    afterCommit: combined,
  };
  if (options.connectivityUrl !== undefined) {
    if (!combined) throw new Error("--connectivity-url applies only to the combined check gate");
    probeUrl(options.connectivityUrl);
  }
  const stagedCommit = !options.list && mode === "pre-commit" ? process.env.WORKBENCH_REVIEW_TREE : undefined;
  if (stagedCommit) {
    const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
    checkRecordRetention(owner, stagedCommit);
    if (!provisionalCommitRequested(stagedCommit)) checkReview(owner, stagedCommit);
    checkAgentCommit(owner, stagedCommit);
  }
  if (!options.list && mode === "pre-push" && process.env.WORKBENCH_PUSH_TIP) {
    if (!process.env.WORKBENCH_PUSH_REMOTE) throw new Error("Push review requires the remote revision");
    const repository = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
    const archiveUpdates = process.env.WORKBENCH_PUSH_UPDATES;
    checkArchivePublication(
      repository,
      archiveUpdates
        ? readFileSync(archiveUpdates, "utf8")
        : `${process.env.WORKBENCH_PUSH_LOCAL_REF ?? "HEAD"} ${process.env.WORKBENCH_PUSH_TIP} ${process.env.WORKBENCH_PUSH_REMOTE_REF ?? "HEAD"} ${process.env.WORKBENCH_PUSH_REMOTE}\n`,
      process.env.WORKBENCH_PUSH_REMOTE_NAME ?? options.remote ?? "",
    );
    checkPushSignatures(
      repository,
      process.env.WORKBENCH_PUSH_TIP,
      process.env.WORKBENCH_PUSH_REMOTE,
      process.env.WORKBENCH_PUSH_REMOTE_URL,
    );
    checkAgentPush(repository, process.env.WORKBENCH_PUSH_TIP, process.env.WORKBENCH_PUSH_REMOTE);
  }
  const selected = mode === "pre-push" ? online : options;
  if (options.list) {
    if (combined && options.json) {
      console.log(
        JSON.stringify({ preCommit: inspectChecks(root, options), prePush: inspectChecks(root, online) }, null, 2),
      );
    } else if (combined) {
      listChecks(root, selected, gateHeadings["pre-commit"]);
      console.log();
      listChecks(root, online, gateHeadings["pre-push"]);
    } else {
      listChecks(root, selected, gateHeadings[mode]);
    }
    return;
  }
  const validateGate = focused ? undefined : () => validate(root, observe);
  if (mode !== "pre-push")
    await runChecks(root, selected, validateGate, recordReport, observe, stagedCommit !== undefined);
  if (mode !== "pre-push" && !combined) return;
  const validatePush = async () => {
    await validateGate?.();
    await verifyCIImages(
      root,
      options.remote ?? process.env.WORKBENCH_PUSH_REMOTE_NAME,
      process.env.WORKBENCH_PUSH_REMOTE_URL,
    );
  };
  if (!inspectChecks(root, online).selected.length) {
    if (mode === "pre-push")
      await measureCheckPhase("Validation and prepared image availability", validatePush, observe);
    console.log(
      combined && options.extended ? "No additional online checks." : "No online pre-push checks are configured.",
    );
    return;
  }
  if (combined && !(await onlineReachable(options.connectivityUrl))) return;
  await runChecks(root, online, mode === "pre-push" ? validatePush : validateGate, recordReport, observe);
}

export async function runGate(
  root: string,
  mode: "check" | "pre-commit" | "pre-push",
  options: GateOptions,
): Promise<void> {
  if (!options.report) return executeGate(root, mode, options);
  if (options.list) throw new Error("--report requires execution; --json describes the plan");
  return withCheckReport(resolve(root, options.report), async (path) => {
    const runs: CheckRunResult[] = [];
    const phases: CheckPhase[] = [];
    const started = new Date().toISOString();
    let success = false;
    let error: string | undefined;
    const save = () => {
      writeCheckReport(path, {
        version: 1,
        kind: "workbench-check-report",
        success,
        started,
        finished: new Date().toISOString(),
        phases,
        ...(error === undefined ? {} : { error }),
        runs,
      });
    };
    try {
      await executeGate(
        root,
        mode,
        options,
        (run) => {
          runs.push(run);
        },
        (phase) => {
          phases.push(phase);
        },
      );
      success = true;
    } catch (failure) {
      error = safeOutput(failure instanceof Error ? failure.message : String(failure)).slice(0, 8192);
      releaseAfterFailure(save, failure, "Check gate and report publication both failed");
    }
    save();
  });
}
