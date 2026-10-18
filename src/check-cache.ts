import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
import { writeAtomic } from "./core.js";
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
  version: 1;
  key: string;
  completed: string;
  checks: number;
  components: CheckFingerprint["components"];
  environmentVariables?: CheckFingerprint["environmentVariables"];
}

const maximumResultBytes = 64 * 1024;

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
      if (statSync(path).size > maximumResultBytes) continue;
      const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Success>;
      if (
        saved.version !== 1 ||
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
  run: (selected: Plan) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (
    options.role?.length ||
    options.excludeRole?.length ||
    options.report ||
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
    console.log(`Check cache unavailable; running fresh: ${error instanceof Error ? error.message : String(error)}`);
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
    console.log(`Check cache ownership unavailable; running fresh: ${String(error)}`);
    await run(plan);
    return;
  }
  const receipt = ownedPath(directory, "result.json");
  const count = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  let validDirectory = true;
  let saved: Partial<Success> | null = null;
  if (existsSync(directory)) {
    try {
      readBuildGeneration(storageRoot, directory, "checks", identity);
      if (statSync(receipt).size > maximumResultBytes) throw new Error("oversized check result");
      saved = JSON.parse(readFileSync(receipt, "utf8")) as Partial<Success> | null;
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
    saved?.version === 1 &&
    saved.key === key &&
    saved.checks === count &&
    typeof saved.completed === "string" &&
    Number.isFinite(Date.parse(saved.completed))
  ) {
    if (verbose) console.log(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s; ${receipt}`);
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
    if (refreshed) {
      console.log(
        `Cached evidence matches ${String(count - refreshed)}/${String(count)} checks; refreshing ${String(refreshed)} setup and security checks.`,
      );
      await run(fresh);
      if (key !== checkFingerprint(root, options, plan).key)
        throw new Error("check inputs changed while refreshing security checks; rerun checks");
    }
    await nextTurn();
    signal?.throwIfAborted();
    console.log(
      refreshed
        ? `Reused ${String(count - refreshed)}/${String(count)} checks (verified ${saved.completed}); ${String(refreshed)} setup and security checks ran fresh. Use --no-cache to rerun all checks.`
        : `Reused successful gate: ${String(count)}/${String(count)} checks (verified ${saved.completed}). Use --no-cache to rerun.`,
    );
    return;
  }
  const previous = options.cache === false ? undefined : previousInputs(storageRoot, directory, identity);
  const changed = previous ? changedCheckInputs(previous, inputs) : [];
  console.log(
    options.cache === false
      ? "Running fresh checks (--no-cache)."
      : `Check cache miss: ${changed.length ? `${changed.join(", ")} changed` : "no reusable successful result"}.`,
  );
  const variables = previous ? changedEnvironmentVariables(previous, inputs) : [];
  if (variables.length)
    console.log(
      `Changed environment variables: ${variables.slice(0, 12).join(", ")}${variables.length > 12 ? ` (and ${String(variables.length - 12)} more)` : ""}. Values are not shown.`,
    );
  if (verbose) console.log(`Check cache lookup: ${((performance.now() - started) / 1000).toFixed(2)} s.`);
  const invalidate = () => {
    if (validDirectory && existsSync(receipt))
      withCacheLockSync(directory, () => {
        readBuildGeneration(storageRoot, directory, "checks", identity);
        rmSync(ownedPath(directory, "result.json"), { force: true });
      });
  };
  // A failed or interrupted fresh run must not leave earlier success evidence usable.
  invalidate();
  try {
    await run(plan);
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
      console.log(
        `Checks passed; inputs changed during execution (${changedCheckInputs(inputs, current).join(", ")}), so this result was not cached.`,
      );
      return;
    }
    const selectedPaths = new Set(
      plan.sessions.map((session) => relative(root, session.directory).split(sep).join("/") || "."),
    );
    const tools = selectedToolRequirements(root, [...selectedPaths], options);
    await nextTurn();
    signal?.throwIfAborted();
    withToolCacheAdmission(() => {
      withCacheLockSync(directory, () => {
        ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
        if (existsSync(directory)) readBuildGeneration(storageRoot, directory, "checks", identity);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeAtomic(ownedPath(directory, ".workbench-check-result.json"), JSON.stringify(identity), 0o600);
        recordResultTools({ directory, storageRoot, identity, kind: "checks", tools }, true);
        const saved: Success = {
          version: 1,
          key,
          checks: count,
          completed: new Date().toISOString(),
          components: inputs.components,
          environmentVariables: inputs.environmentVariables,
        };
        writeAtomic(ownedPath(directory, "result.json"), JSON.stringify(saved), 0o600);
      });
    });
    if (verbose) console.log(`Saved successful gate: ${receipt}`);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`Checks passed, but the result could not be cached: ${String(error)}`);
  }
}
