import { buildProjectImage } from "./buildkit.js";
import { ciImageContext, verifyCIImage } from "../scripts/ci-image.mjs";
import { provisionCollectionSnapshot } from "./collection-provision.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ciTargets, printCITargets, type CITarget } from "./ci-targets.js";
import { prepareOfflineProfile, preparedOfflineProfile, offlineProfile } from "./offline-profiles.js";
import { distributionRoot, readText, readConfig } from "./core.js";
import { CILifecycle, CIInterrupted, executeCI } from "./ci-lifecycle.js";
import { parseCIWorkerRequest, type CIWorkerRequest } from "../scripts/ci-worker-request.mjs";
import { userDirectory } from "./storage.js";
import { quote } from "./toolchains.js";
import { required } from "./invariants.js";
import { CIWorkspace } from "./ci-workspace.js";
import { executionResources } from "./execution-resources.js";
import { cpuEnvironment } from "../scripts/cpu-budget.mjs";
import { runCIWorkers, type CIWorker } from "./local-ci-workers.js";
import { ciCacheEnvironment } from "../scripts/ci-layout.mjs";
import { targetPhases } from "../scripts/ci-contract.mjs";
import {
  createRunReport,
  parseRunReport,
  writeRunReport,
  runSucceeded,
  runSummary,
  errorMessage,
} from "../scripts/ci-results.mjs";

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
  return {
    platform: "linux-x64",
    network: "host",
    image: baseImage,
    stage: "ci",
    prepared: existsSync(join(root, "workbench/config.toml")) ? (readConfig(root).ci?.images ?? {}) : {},
    selected,
    excluded,
    cache: userDirectory("cache"),
    resources: {
      ...executionResources(root, Math.max(1, selected.length)),
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
    if (existsSync(join(resources.workspace, "workbench/projects.toml")))
      provisionCollectionSnapshot(root, resources.workspace);
    writeFileSync(join(resources.reports, "source-trees.json"), JSON.stringify(trees, null, 2));
    await lifecycle.checkpoint();
    if (existsSync(join(resources.workspace, "workbench/projects.toml")))
      await executeCI(
        process.execPath,
        [join(resources.workspace, guestDistribution, "bin/workbench.mjs"), "validate"],
        {
          cwd: resources.workspace,
          env: {
            ...process.env,
            WORKBENCH_COLLECTIONS_MATERIALIZED: "1",
            WORKBENCH_PROJECT_ROOT: resources.workspace,
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
    for (const target of plan.selected) {
      const preparedTarget = prepared.get(target.environment === "nix-docker" ? "nix" : target.environment);
      if (target.kind !== "environment" && !image && !preparedTarget) continue;
      const report = required(
        run.targets.find((entry) => entry.id === target.id),
        "selected target result",
      ).report;
      mkdirSync(report, { recursive: true });
      workers.push({
        id: target.id,
        log: join(report, "job.log"),
        start: async () => {
          const workspace = await resources.fork(target.id);
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
            WORKBENCH_PROJECT_ROOT: workspace,
            WORKBENCH_DISTRIBUTION_ROOT: jobDistribution,
          };
          const value: CIWorkerRequest = {
            version: 1,
            workspace,
            distribution: jobDistribution,
            target,
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
            const index = run.targets.findIndex((entry) => entry.id === target.id);
            run.targets[index] = required(returned.targets[0], "worker target result");
            run.errors.push(...returned.errors);
            if (error && runSucceeded(returned))
              run.errors.push({ phase: `worker:${target.id}`, message: error.message });
          } catch (failure) {
            run.errors.push({ phase: `worker:${target.id}`, message: errorMessage(error ?? failure) });
          } finally {
            run.errors.push(...(await resources.release(target.id)));
            save();
          }
        },
      });
    }
    await runCIWorkers(workers, plan.resources.maxJobs, lifecycle);
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
  for (const error of run.errors) console.error(`${error.phase}: ${error.message}`);
  if (!runSucceeded(run)) throw new Error(`Local CI failed; inspect ${resultsPath}`);
}
