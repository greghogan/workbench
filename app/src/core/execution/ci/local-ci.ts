import { projectPaths } from "../../projects/project-paths.js";
import { writeDiagnosticText } from "../../diagnostics/diagnostics.mjs";
import { terminalTable } from "../../diagnostics/terminal-table.js";
import { buildProjectImage } from "../../artifacts/buildkit.js";
import { ciImageContext, verifyCIImage } from "./support/ci-image.mjs";
import { provisionCollectionSnapshot } from "../../collections/collection-provision.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ciTargets, printCITargets, type CITarget } from "./ci-targets.js";
import { prepareOfflineProfile, preparedOfflineProfile, offlineProfile } from "../../artifacts/offline-profiles.js";
import { distributionRoot } from "../../projects/project-context.js";
import { readText } from "../../runtime/files.js";
import { readConfig, readProjects } from "../../projects/project-configuration.js";
import { CILifecycle, CIInterrupted, executeCI } from "./support/ci-lifecycle.mjs";
import { parseCIWorkerRequest, type CIWorkerRequest } from "./support/ci-worker-request.mjs";
import { userDirectory } from "../../storage/storage.js";
import { quote } from "../../toolchains/toolchains.js";
import { required } from "../../runtime/invariants.js";
import { CIWorkspace } from "./ci-workspace.js";
import { executionResources } from "../environments/execution-resources.js";
import { cpuEnvironment } from "../checks/cpu-budget.mjs";
import { runCIWorkers, type CIWorker } from "./local-ci-workers.js";
import { ciCacheEnvironment } from "./support/ci-layout.mjs";
import { configuredCIJobs, assertOperationCoverage } from "./support/ci-operations.mjs";
import { targetPhases } from "./support/ci-contract.mjs";
import { plannedCIPackages } from "./ci-packages.js";
import {
  createRunReport,
  parseRunReport,
  writeRunReport,
  runSucceeded,
  runSummary,
  errorMessage,
} from "./support/ci-results.mjs";

export interface LocalCIOptions {
  path?: string;
  target?: string[];
  release?: boolean;
}
const baseImage = "ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944";

/** Local selection projects the complete hosted catalog without emulation. */
export function localCIPlan(root: string, options: LocalCIOptions = {}) {
  const targets = ciTargets(root);
  if (options.path !== undefined && !targets.some((target) => target.path === options.path))
    throw new Error("--path must select a configured CI root");
  if (options.target?.some((id) => !targets.some((target) => target.id === id)))
    throw new Error("--target must name a configured CI target; inspect workbench ci --plan");
  const selected: CITarget[] = [];
  const excluded: { target: CITarget; reason: string }[] = [];
  for (const target of targets) {
    const reason =
      target.os !== "linux" || target.architecture !== "x64"
        ? "requires its native hosted platform; no emulation"
        : options.path !== undefined && target.path !== options.path
          ? "outside selected root"
          : options.target && !options.target.includes(target.id)
            ? "outside selected targets"
            : undefined;
    if (reason) excluded.push({ target, reason });
    else {
      const selection =
        target.kind === "native" ? { ...target, release: target.release && options.release !== false } : target;
      selected.push({
        ...selection,
        phases: targetPhases(selection),
        checks:
          selection.kind === "native" && !selection.release
            ? selection.checks.filter((check) => !["release", "release-verify"].includes(check.role))
            : selection.checks,
      });
    }
  }
  if (!selected.length) throw new Error("Local CI selection has no configured Linux x64 targets");
  const operations = configuredCIJobs(selected);
  assertOperationCoverage(selected, operations);
  const native = targets.filter((target) => target.kind === "native");
  const packages = plannedCIPackages(root, new Set(native.map(({ os, architecture }) => `${os}-${architecture}`)));
  const scopePaths = new Map(packages.selected.length ? readProjects(root).map(({ id, path }) => [id, path]) : []);
  const localPackages = [];
  for (const { id, row } of packages.selected) {
    const path = required(scopePaths.get(row.definition.owner), "CI package owner");
    const checkRoot = native
      .filter(({ path: directory }) => directory === "." || path === directory || path.startsWith(directory + "/"))
      .sort((left, right) => right.path.length - left.path.length)[0]?.path;
    const inSelection = selected.some(
      (target) =>
        target.path === checkRoot &&
        (!options.target ||
          (target.kind === "native"
            ? row.builder === "native" && !target.toolchain
            : target.kind === "environment" &&
              row.builder === (target.environment === "nix-docker" ? "nix" : target.environment))),
    );
    const reason =
      options.release === false
        ? "release verification disabled for this run"
        : row.platform !== "linux-x64"
          ? `requires native ${row.platform}`
          : (options.path || options.target) && !inSelection
            ? "outside selected check roots"
            : undefined;
    if (reason) packages.excluded.push({ id, reason });
    else localPackages.push({ id, row });
  }
  return {
    operations,
    packages: localPackages,
    excludedPackages: packages.excluded,
    platform: "linux-x64",
    network: "host",
    image: baseImage,
    stage: "ci",
    prepared: existsSync(join(root, projectPaths.config)) ? (readConfig(root).ci?.images ?? {}) : {},
    selected,
    excluded,
    cache: userDirectory("cache"),
    resources: {
      ...executionResources(
        root,
        Math.max(
          1,
          operations.reduce((sum, job) => sum + job.targets.length, 0),
        ),
      ),
      ...(selected.length ? {} : { maxJobs: 0 }),
    },
  };
}

export function listLocalCI(root: string, options: LocalCIOptions, json = false): void {
  const plan = localCIPlan(root, options);
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log("Local CI: Linux x64; native execution without emulation.");
  printCITargets(plan.selected);
  console.log(`Cache: ${plan.cache}`);
  console.log(
    `CPU budget: ${String(plan.resources.cpusPerJob)} per job; up to ${String(plan.resources.maxJobs)} concurrent jobs (${String(plan.resources.availableCpus)} available CPUs).`,
  );
  console.log(
    `${String(plan.excluded.length)} targets excluded; --plan --json includes reasons and resolved commands.`,
  );
  if (plan.packages.length) {
    console.log("\nRelease packages");
    console.log(
      terminalTable(
        ["Profile", "Target", "Format"],
        plan.packages.map(({ row }) => [row.profile, row.target, row.archive ?? row.format]),
      ),
    );
  }
  console.log(
    "Configured prepared images are shared with development; other native targets use Ubuntu and verified caches.",
  );
  console.log(
    "GitHub permissions, OIDC, registry publication, and other native platforms require hosted verification.",
  );
}

async function rehearsalImage(root: string, distribution: string, context: string, image: string): Promise<string> {
  const tag = ciImageContext(distribution, context, image);
  await buildProjectImage(root, [
    "--platform",
    "linux/amd64",
    "--network=host",
    "--build-arg",
    `BASE_IMAGE=${image}`,
    "--tag",
    tag,
    context,
  ]);
  verifyCIImage(tag);
  return tag;
}

/** A scoped Docker client adapter applies the same rehearsal network to managed launchers. */
export function rehearsalDocker(path: string, docker: string): void {
  if (!isAbsolute(docker)) throw new Error("Local CI requires an absolute Docker client path");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "operation=$1; shift",
      'case "$operation" in',
      `run|build) exec ${quote(docker)} "$operation" --network=host "$@";;`,
      `buildx) if [ "\${1:-}" = build ]; then shift; exec ${quote(docker)} buildx build --network=host "$@"; fi;;`,
      "esac",
      `exec ${quote(docker)} "$operation" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}

export async function runLocalCI(root: string, options: LocalCIOptions = {}): Promise<void> {
  const plan = localCIPlan(root, options);
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Local CI requires a native Linux x64 host; emulation is not selected");
  const distribution = distributionRoot(root);
  const inside = relative(root, distribution);
  const guestDistribution =
    isAbsolute(inside) || inside === ".." || inside.startsWith("../") ? ".git/workbench/runtime" : inside;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("Local CI requires a native Linux user");
  const lifecycle = new CILifecycle();
  let resources: CIWorkspace;
  try {
    resources = new CIWorkspace(root);
  } catch (error) {
    lifecycle.close();
    throw error;
  }
  const run = createRunReport(
    plan.selected.map((target) => target.id),
    resources.reports,
  );
  const resultsPath = join(resources.reports, "results.json");
  const save = () => {
    writeRunReport(resultsPath, run);
  };
  console.log(`Local CI reports and release artifacts: ${resources.reports}`);
  try {
    await lifecycle.checkpoint();
    save();
    writeFileSync(join(resources.reports, "plan.json"), JSON.stringify(plan, null, 2));
    if (plan.selected.some((target) => ["nix-docker", "devcontainer"].includes(target.environment)))
      rehearsalDocker(
        resources.adapter,
        (await executeCI("sh", ["-eu", "-c", "command -v docker"], { capture: true })).trim(),
      );
    const prepared = new Map<string, { profile: string; image: string }>();
    for (const [builder, profile] of Object.entries(plan.prepared)) {
      if (
        !plan.selected.some((target) => (target.environment === "nix-docker" ? "nix" : target.environment) === builder)
      )
        continue;
      await prepareOfflineProfile(root, profile, { fresh: true });
      prepared.set(builder, { profile, image: preparedOfflineProfile(root, offlineProfile(root, profile)).image });
    }
    const shared: Record<string, string> = {
      ...ciCacheEnvironment(plan.cache, undefined, true),
      WORKBENCH_CONTAINER_CHECKOUT: realpathSync(root),
      WORKBENCH_COLLECTIONS_MATERIALIZED: "1",
    };
    await lifecycle.checkpoint();
    const trees = await resources.snapshot(lifecycle);
    await lifecycle.checkpoint();
    if (existsSync(join(resources.workspace, projectPaths.projects)))
      provisionCollectionSnapshot(root, resources.workspace);
    writeFileSync(join(resources.reports, "source-trees.json"), JSON.stringify(trees, null, 2));
    await lifecycle.checkpoint();
    if (existsSync(join(resources.workspace, projectPaths.projects)))
      await executeCI(
        process.execPath,
        [join(resources.workspace, guestDistribution, "bin/workbench.mjs"), "validate"],
        {
          cwd: resources.workspace,
          env: {
            ...process.env,
            WORKBENCH_COLLECTIONS_MATERIALIZED: "1",
            WORKBENCH_PROJECT_ROOT: resources.workspace,
            WORKBENCH_EPHEMERAL_CHECKOUT: "1",
            WORKBENCH_LOCAL_CONFIG_ROOT: root,
            WORKBENCH_DISTRIBUTION_ROOT: join(resources.workspace, guestDistribution),
          },
        },
      );
    await lifecycle.checkpoint();
    let image: string | undefined;
    if (!prepared.has("native") && plan.selected.some((target) => target.kind !== "environment")) {
      try {
        image = await rehearsalImage(root, join(resources.workspace, guestDistribution), resources.context, plan.image);
      } catch (error) {
        run.errors.push({ phase: "container preparation", message: errorMessage(error) });
      }
    }
    await lifecycle.checkpoint();
    for (const path of [
      plan.cache,
      required(shared.CARGO_HOME, "CI Cargo cache"),
      required(shared.RUSTUP_HOME, "CI rustup cache"),
    ])
      mkdirSync(path, { recursive: true });
    const workers: CIWorker[] = [];
    const units = plan.operations.flatMap((job) =>
      job.targets.map((target) => ({ target, operation: job.operation, id: `${target.id}/${job.artifact}` })),
    );
    const completed = new Map<string, import("./support/ci-results.mjs").TargetResult>();
    for (const unit of units) {
      const { target, operation } = unit;
      const preparedTarget = prepared.get(target.environment === "nix-docker" ? "nix" : target.environment);
      if (target.kind !== "environment" && !image && !preparedTarget) continue;
      const targetReport = required(
        run.targets.find((entry) => entry.id === target.id),
        "selected target result",
      ).report;
      const multiple = units.filter((entry) => entry.target.id === target.id).length > 1;
      const report = multiple ? join(targetReport, "operations", operation) : targetReport;
      mkdirSync(report, { recursive: true });
      workers.push({
        id: unit.id,
        log: join(report, "job.log"),
        start: async () => {
          const workspace = await resources.fork(unit.id);
          const jobShared: Record<string, string> = {
            ...shared,
            ...cpuEnvironment(plan.resources.cpusPerJob),
            WORKBENCH_CI_TARGET: target.id,
            WORKBENCH_LOCAL_CI_IMAGE: preparedTarget?.image ?? plan.image,
          };
          const jobDistribution = join(workspace, guestDistribution);
          const request = join(report, "request.json");
          const env = {
            ...process.env,
            ...jobShared,
            // A rehearsal owns its frozen checkout; an enclosing hosted candidate belongs to another run.
            WORKBENCH_CI_CANDIDATE: undefined,
            WORKBENCH_PROJECT_ROOT: workspace,
            WORKBENCH_DISTRIBUTION_ROOT: jobDistribution,
          };
          const value: CIWorkerRequest = {
            version: 1,
            workspace,
            distribution: jobDistribution,
            target,
            operation,
            reports: report,
            ...(preparedTarget
              ? { image: preparedTarget.image, profile: preparedTarget.profile }
              : image
                ? { image }
                : {}),
            cache: plan.cache,
            shared: jobShared,
            adapter: resources.adapter,
            uid,
            gid,
          };
          writeFileSync(request, JSON.stringify(parseCIWorkerRequest(value)));
          return {
            command: process.execPath,
            args: [join(jobDistribution, "scripts/ci-linux/job.mjs"), request],
            env,
          };
        },
        finish: async (error) => {
          try {
            const returned = parseRunReport(
              JSON.parse(readText(join(report, "job-results.json"))) as unknown,
              [target.id],
              report,
            );
            if (completed.has(unit.id)) throw new Error("CI operation completed more than once");
            completed.set(unit.id, required(returned.targets[0], "worker target result"));
            const expected = units.filter((entry) => entry.target.id === target.id);
            const outcomes = expected.flatMap((entry) => {
              const result = completed.get(entry.id);
              return result ? [result] : [];
            });
            const index = run.targets.findIndex((entry) => entry.id === target.id);
            const finished = outcomes.length === expected.length;
            const errors = outcomes.filter((entry) => !entry.success).map((entry) => entry.error ?? "Operation failed");
            const started = outcomes.flatMap((entry) => (entry.started ? [entry.started] : [])).sort()[0];
            const ended =
              finished && outcomes.every((entry) => entry.finished)
                ? outcomes
                    .map((entry) => entry.finished ?? "")
                    .sort()
                    .at(-1)
                : undefined;
            run.targets[index] = {
              id: target.id,
              report: multiple ? targetReport : (outcomes[0]?.report ?? targetReport),
              success: finished && !errors.length,
              ...(!finished || errors.length
                ? {
                    error:
                      errors.join("; ") || `Completed ${String(outcomes.length)}/${String(expected.length)} operations`,
                  }
                : {}),
              ...(started === undefined ? {} : { started }),
              ...(ended === undefined ? {} : { finished: ended }),
            };
            run.errors.push(...returned.errors);
            if (error && runSucceeded(returned))
              run.errors.push({ phase: `worker:${target.id}`, message: error.message });
          } catch (failure) {
            run.errors.push({ phase: `worker:${target.id}`, message: errorMessage(error ?? failure) });
          } finally {
            run.errors.push(...(await resources.release(unit.id)));
            save();
          }
        },
      });
    }
    await runCIWorkers(workers, plan.resources.maxJobs, lifecycle, root);
    if (plan.packages.length) {
      const id = "release-packages";
      try {
        await lifecycle.checkpoint();
        const workspace = await resources.fork(id);
        const runtime = join(workspace, guestDistribution);
        await executeCI(
          process.execPath,
          [
            join(runtime, "bin/workbench.mjs"),
            "ci",
            "verify-packages",
            ...plan.packages.map(({ id }) => id),
            "--output",
            join(resources.reports, id),
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              ...shared,
              ...cpuEnvironment(plan.resources.cpusPerJob),
              WORKBENCH_CI_CANDIDATE: undefined,
              WORKBENCH_COLLECTIONS_MATERIALIZED: "1",
              WORKBENCH_PROJECT_ROOT: workspace,
              WORKBENCH_EPHEMERAL_CHECKOUT: "1",
              WORKBENCH_LOCAL_CONFIG_ROOT: root,
              WORKBENCH_DISTRIBUTION_ROOT: runtime,
            },
          },
        );
      } catch (error) {
        if (error instanceof CIInterrupted) throw error;
        run.errors.push({ phase: id, message: errorMessage(error) });
      } finally {
        run.errors.push(...(await resources.release(id)));
      }
    }
    save();
  } catch (error) {
    if (!(error instanceof CIInterrupted))
      run.errors.push({ phase: "preparation or execution", message: errorMessage(error) });
  } finally {
    try {
      run.errors.push(...(await resources.close()));
      if (lifecycle.interrupted) run.errors.push({ phase: "interruption", message: new CIInterrupted().message });
      save();
    } finally {
      lifecycle.close();
    }
  }
  console.log(runSummary(run, resources.reports));
  for (const error of run.errors) writeDiagnosticText(`${error.phase}: ${error.message}`);
  if (!runSucceeded(run)) throw new Error(`Local CI failed; inspect ${resultsPath}`);
}
