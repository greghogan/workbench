import { readDistributionPin } from "./distribution-manifest.js";
import { ciSelection, printCISelection, type CISelectionOptions } from "./ci-selection.js";
import { validate } from "./validation.js";
import { provisionCollectionSnapshot } from "./collection-provision.js";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ciTargets, printCITargets, type CITarget } from "./ci-targets.js";
import { distributionRoot, readText } from "./core.js";
import { type ToolAsset } from "./tool-downloads.js";
import { CILifecycle, CIInterrupted, executeCI } from "./ci-lifecycle.js";
import { parseCIWorkerRequest, type CIWorkerRequest } from "../scripts/ci-worker-request.mjs";
import { userDirectory } from "./storage.js";
import { ownedPath } from "./paths.js";
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

export interface LocalCIOptions extends CISelectionOptions {
  path?: string;
  target?: string[];
  release?: boolean;
}
const baseImage = "ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** Local selection projects the complete hosted catalog without emulation. */
export function localCIPlan(root: string, options: LocalCIOptions = {}) {
  const targets = ciTargets(root);
  const selection = ciSelection(root, options);
  const affectedRoots = new Set(selection.selected.map((entry) => entry.path));
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
        : !affectedRoots.has(target.path)
          ? "no changed inputs or dependencies"
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
  if (!selected.length && selection.selected.length)
    throw new Error("Local CI selection has no configured Linux x64 targets");
  return {
    selection,
    platform: "linux-x64",
    network: "host",
    image: baseImage,
    stage: "ci",
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
  printCISelection(plan.selection);
  printCITargets(plan.selected);
  console.log(`Cache: ${plan.cache}`);
  console.log(
    `CPU budget: ${String(plan.resources.cpusPerJob)} per job; up to ${String(plan.resources.maxJobs)} concurrent jobs (${String(plan.resources.availableCpus)} available CPUs).`,
  );
  console.log(
    `${String(plan.excluded.length)} targets excluded; --plan --json includes reasons and resolved commands.`,
  );
  console.log(
    "Native and compatibility targets use the Ubuntu container. Managed targets use their configured host launchers.",
  );
  console.log(
    "GitHub permissions, OIDC, registry publication, and other native platforms require hosted verification.",
  );
}

async function rehearsalImage(distribution: string, context: string, image: string): Promise<string> {
  cpSync(join(distribution, "scripts/ci-linux"), context, { recursive: true });
  const node = readText(join(distribution, ".node-version")).trim();
  const assets = JSON.parse(readFileSync(join(distribution, "scripts/native-assets.json"), "utf8")) as Record<
    string,
    Record<string, Record<string, ToolAsset>>
  >;
  const asset = assets.node?.[node]?.["linux-x64"];
  if (!asset?.checksums) throw new Error("Local CI requires a signed Linux x64 Node bootstrap artifact");
  cpSync(ownedPath(distribution, asset.checksums.signature.keys), join(context, "node.asc"));
  asset.checksums.signature.keys = "node.asc";
  writeFileSync(join(context, "bootstrap.json"), JSON.stringify(asset));
  const recipe = digest(
    JSON.stringify([
      image,
      ...["Dockerfile", "bootstrap.py", "bootstrap.json", "node.asc"].map((name) => readText(join(context, name))),
    ]),
  );
  const tag = `workbench-ci:${recipe}`;
  await executeCI("docker", ["build", "--network=host", "--build-arg", `BASE_IMAGE=${image}`, "--tag", tag, context]);
  const platform = JSON.parse(
    await executeCI("docker", ["image", "inspect", "--format", "{{json .}}", tag], { capture: true }),
  ) as { Os: string; Architecture: string };
  if (platform.Os !== "linux" || platform.Architecture !== "amd64")
    throw new Error("Local CI image is not native Linux x64");
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
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Local CI requires a native Linux x64 host; emulation is not selected");
  const plan = localCIPlan(root, options);
  if (!plan.selected.length) {
    await validate(root);
    printCISelection(plan.selection);
    console.log("Validation passed; no affected Linux x64 targets. No example tools, caches, or workspaces acquired.");
    return;
  }
  const distribution = distributionRoot(root);
  const guestDistribution = readDistributionPin(root) ? ".workbench" : relative(root, distribution);
  if (isAbsolute(guestDistribution) || guestDistribution === ".." || guestDistribution.startsWith("../"))
    throw new Error("Workbench distribution must belong to the project checkout for local CI");
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
    const shared: Record<string, string> = {
      ...ciCacheEnvironment(plan.cache, undefined, true),
      WORKBENCH_CONTAINER_CHECKOUT: `${resolve(root)}#local-ci:${digest(plan.image)}`,
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
    if (plan.selected.some((target) => target.kind !== "environment")) {
      try {
        image = await rehearsalImage(join(resources.workspace, guestDistribution), resources.context, plan.image);
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
      if (target.kind !== "environment" && !image) continue;
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
          const jobShared = {
            ...shared,
            ...cpuEnvironment(plan.resources.cpusPerJob),
            WORKBENCH_CONTAINER_CHECKOUT: `${shared.WORKBENCH_CONTAINER_CHECKOUT ?? ""}#${target.id}`,
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
            ...(image ? { image } : {}),
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
