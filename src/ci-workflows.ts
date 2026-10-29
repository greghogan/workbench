import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { stringify, Document, visit, isScalar } from "yaml";
import { readText } from "./files.js";
import { readConfig } from "./project-configuration.js";
import {
  CIProvider,
  ciPlatforms,
  githubRunner,
  readCIDestinations,
  repositoryIdentity,
  repositoryTransport,
  type CIDestination,
} from "./ci-hosting.js";
import { ciDestination, pairedRegistries, remoteTransport } from "./ci-destinations.js";
import { ciTargets } from "./ci-targets.js";
import { ciJobGroups, type CIJobGroup } from "./ci-job-plan.js";
import { editToml } from "./toml-edit.js";
import { ProjectEdits } from "./project-edits.js";
import { distributionRoot } from "./project-context.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { ownedPath } from "./paths.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import { readCIActionPins, ciActionManifest } from "../scripts/ci-actions.mjs";
import { RegistryProvider, readRegistryManagement } from "./registry-management-contract.js";

const quote = (value: string, os = "linux") => `'${value.replaceAll("'", os === "windows" ? "''" : "'\\''")}'`;
const reports = ".workbench-ci/reports";
const platformWorkflow = ".github/workflows/workbench-platform.yml";
interface CIRenderContext {
  command: string;
  source: string;
  bootstrap: string[];
  node: string;
  actions: Record<string, { version: string; revision: string }>;
  groups: CIJobGroup[];
}
function renderContext(root: string): CIRenderContext {
  return withConfigurationSnapshot(() => {
    const config = readConfig(root),
      directory = ".workbench-ci/tool",
      pin = config.tool;
    if (!pin && !existsSync(join(root, "bin/workbench.mjs")))
      throw new Error("CI setup requires a pinned Workbench executable in [tool]");
    const distribution = distributionRoot(root);
    return {
      command: pin ? `node ${directory}/bin/workbench.mjs` : "node bin/workbench.mjs",
      source: pin ? directory : ".",
      bootstrap: pin
        ? [
            `git init ${quote(directory)}`,
            `git -C ${quote(directory)} remote add origin ${quote(pin.repository.replace(/^git\+/, "").replaceAll("'", "%27"))}`,
            `git -C ${quote(directory)} fetch --depth 1 origin ${quote(pin.revision)}`,
            `git -C ${quote(directory)} checkout --detach ${quote(pin.revision)}`,
          ]
        : [],
      node: readText(join(distribution, ".node-version")).trim(),
      actions: readCIActionPins(readText(join(distribution, ciActionManifest))),
      groups: ciJobGroups(root, ciTargets(root)),
    };
  });
}
function action(context: CIRenderContext, name: string): string {
  const pin = context.actions[name];
  if (!pin) throw new Error(`Missing immutable workflow component: ${name}`);
  return `${name}@${pin.revision}`;
}
function registryLogin(destination: CIDestination, os: string): string[] {
  if (os !== "linux") return [];
  const hosts = [...new Set(Object.values(destination.registries).map((repository) => repository.split("/")[0] ?? ""))];
  if (hosts.length !== 1) return [];
  if (destination.provider === CIProvider.GitLab)
    return hosts.map(
      (host) =>
        `if [ "\${CI_REGISTRY:-}" = ${quote(host)} ]; then DOCKER_CONFIG=$(mktemp -d) || exit 1; export DOCKER_CONFIG; trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT; printf '%s' "\${CI_DEPLOY_PASSWORD:-$CI_REGISTRY_PASSWORD}" | docker login ${quote(host)} --username "\${CI_DEPLOY_USER:-$CI_REGISTRY_USER}" --password-stdin; fi`,
    );
  return hosts[0] === "ghcr.io"
    ? [
        `umask 077; mkdir -p "$DOCKER_CONFIG"; printf '%s' "$WORKBENCH_REGISTRY_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin`,
      ]
    : [];
}
function githubSteps(context: CIRenderContext, destination?: CIDestination) {
  const login = destination ? registryLogin(destination, "linux") : [];
  const auth = login.length ? { DOCKER_CONFIG: "${{ runner.temp }}/workbench-docker-auth" } : {};
  return {
    before: [
      {
        run: "git config --global core.autocrlf false\ngit config --global core.symlinks true\ngit config --global core.longpaths true",
      },
      { uses: action(context, "actions/checkout"), with: { "persist-credentials": false, "fetch-depth": 0 } },
      { uses: action(context, "actions/setup-node"), with: { "node-version": context.node } },
      { uses: action(context, "ilammy/msvc-dev-cmd"), if: "runner.os == 'Windows'" },
      ...login.map((run) => ({
        run,
        if: "runner.os == 'Linux'",
        env: { ...auth, WORKBENCH_REGISTRY_TOKEN: "${{ github.token }}" },
      })),
      ...[...context.bootstrap, `${context.command} project add .`].map((run) => ({ run })),
    ],
    auth,
    after: login.length
      ? [{ run: 'rm -rf -- "$DOCKER_CONFIG"', if: "always() && runner.os == 'Linux'", env: auth }]
      : [],
  };
}
function runnerTags(destination: CIDestination, group: CIJobGroup): string[] {
  return destination.runners?.[`${group.os}-${group.architecture}`] ?? [`workbench-${group.os}-${group.architecture}`];
}
export function renderCIPipeline(root: string, destination: CIDestination, groupID?: string): string {
  const context = renderContext(root);
  if (groupID) {
    const group = context.groups.find((group) => group.id === groupID);
    if (!group) throw new Error(`Unknown CI preparation group: ${groupID}`);
    return (
      JSON.stringify(
        { include: group.jobs.map((job) => ({ id: job.artifact, label: job.label, operation: job.operation })) },
        null,
        2,
      ) + "\n"
    );
  }
  if (destination.provider === CIProvider.GitHub)
    return (
      JSON.stringify(
        {
          include: context.groups.map((group) => ({
            id: group.id,
            os: group.os,
            architecture: group.architecture,
            runner: githubRunner(group.os, group.architecture),
            paths: [...new Set(group.targets.map((target) => target.path))],
            hostPrerequisites: !group.profile && group.environment === "native",
          })),
        },
        null,
        2,
      ) + "\n"
    );
  const jobs: Record<string, unknown> = {};
  for (const group of context.groups) {
    const prepared = `.workbench-ci/prepared/${group.id}`;
    const prepare = `prepare-${group.id}`;
    const cache = {
      key: `workbench-${group.id}-$CI_COMMIT_SHA`,
      paths: [".workbench-ci/cache/downloads/", ".workbench-ci/cache/toolchains/"],
    };
    const base = { tags: runnerTags(destination, group), timeout: "2h", interruptible: true };
    const commands = [
      ...registryLogin(destination, group.os),
      ...context.bootstrap,
      `${context.command} project add .`,
    ];
    jobs[prepare] = {
      ...base,
      stage: "prepare",
      cache: { ...cache, policy: "pull-push" },
      script: [
        ...commands,
        `${context.command} ci prepare ${quote(group.id)} --destination ${quote(destination.remote)} --output ${quote(prepared)}`,
      ],
      artifacts: { when: "on_success", paths: [`${prepared}/`], expire_in: "1 day" },
    };
    for (const job of group.jobs)
      jobs[`check-${group.id}-${job.artifact}`] = {
        ...base,
        stage: "check",
        needs: [{ job: prepare, artifacts: true }],
        cache: { ...cache, policy: "pull" },
        script: [
          ...commands,
          `${context.command} ci run ${quote(group.id)} ${quote(job.artifact)} --destination ${quote(destination.remote)} --prepared ${quote(`${prepared}/prepared.json`)} --reports ${quote(`${reports}/${group.id}/${job.artifact}`)}`,
        ],
        artifacts: { when: "always", paths: [`${reports}/${group.id}/${job.artifact}/`], expire_in: "14 days" },
      };
  }
  return stringify({
    stages: ["prepare", "check"],
    variables: {
      GIT_DEPTH: "0",
      WORKBENCH_CACHE_HOME: "$CI_PROJECT_DIR/.workbench-ci/cache",
      WORKBENCH_DATA_HOME: "$CI_PROJECT_DIR/.workbench-ci/data",
      WORKBENCH_STATE_HOME: "$CI_PROJECT_DIR/.workbench-ci/state",
    },
    ...jobs,
  });
}
function githubYAML(context: CIRenderContext, value: unknown): string {
  const document = new Document(value, { aliasDuplicateObjects: false });
  visit(document, {
    Pair: (_key, pair) => {
      if (
        !isScalar(pair.key) ||
        pair.key.value !== "uses" ||
        !isScalar(pair.value) ||
        typeof pair.value.value !== "string"
      )
        return;
      const [name] = pair.value.value.split("@");
      const pin = name ? context.actions[name] : undefined;
      if (pin) pair.value.comment = ` v${pin.version}`;
    },
  });
  return document.toString();
}
function githubPlatformWorkflow(context: CIRenderContext, destination: CIDestination): string {
  const steps = githubSteps(context, destination);
  const authentication = Object.keys(steps.auth).length ? { env: steps.auth } : {};
  const group = '"$WORKBENCH_CI_GROUP"',
    remote = '"$WORKBENCH_DESTINATION"';
  const cache = {
    uses: action(context, "actions/cache"),
    with: {
      key: "workbench-${{ fromJSON(inputs.platform).id }}-${{ github.sha }}",
      path: ".workbench-ci/cache/downloads\n.workbench-ci/cache/toolchains",
    },
  };
  const prerequisites = {
    run: `node ${context.source}/scripts/ci-native-prerequisites.mts`,
    if: "fromJSON(inputs.platform).hostPrerequisites",
  };
  const common = { "runs-on": "${{ fromJSON(inputs.platform).runner }}", "timeout-minutes": 120 };
  const upload = (name: string, path: string) => ({
    uses: action(context, "actions/upload-artifact"),
    with: { name, path, "include-hidden-files": true, "retention-days": 14 },
  });
  return githubYAML(context, {
    name: "Workbench platform",
    on: {
      workflow_call: {
        inputs: { platform: { type: "string", required: true }, destination: { type: "string", required: true } },
      },
    },
    permissions: { contents: "read", packages: "read" },
    defaults: { run: { shell: "bash" } },
    env: {
      GH_TOKEN: "${{ github.token }}",
      WORKBENCH_CI_GROUP: "${{ fromJSON(inputs.platform).id }}",
      CHECK_ROOTS: "${{ toJSON(fromJSON(inputs.platform).paths) }}",
      WORKBENCH_DESTINATION: "${{ inputs.destination }}",
      WORKBENCH_CACHE_HOME: "${{ github.workspace }}/.workbench-ci/cache",
      WORKBENCH_DATA_HOME: "${{ github.workspace }}/.workbench-ci/data",
      WORKBENCH_STATE_HOME: "${{ github.workspace }}/.workbench-ci/state",
    },
    jobs: {
      prepare: {
        ...common,
        outputs: { matrix: "${{ steps.operations.outputs.matrix }}" },
        steps: [
          ...steps.before,
          cache,
          prerequisites,
          {
            run: `${context.command} ci prepare ${group} --destination ${remote} --output .workbench-ci/prepared`,
            ...authentication,
          },
          {
            run: `${context.command} ci pipeline --destination ${remote} --group ${group} --output .workbench-ci/operations.json`,
          },
          { id: "operations", run: matrixOutput(".workbench-ci/operations.json") },
          upload("prepared-${{ fromJSON(inputs.platform).id }}", ".workbench-ci/prepared/"),
          ...steps.after,
        ],
      },
      operations: {
        ...common,
        needs: ["prepare"],
        strategy: { "fail-fast": false, matrix: "${{ fromJSON(needs.prepare.outputs.matrix) }}" },
        env: { WORKBENCH_CI_OPERATION_ID: "${{ matrix.id }}" },
        steps: [
          ...steps.before,
          cache,
          prerequisites,
          {
            uses: action(context, "actions/download-artifact"),
            with: { name: "prepared-${{ fromJSON(inputs.platform).id }}", path: ".workbench-ci/prepared" },
          },
          {
            run: `${context.command} ci run ${group} "$WORKBENCH_CI_OPERATION_ID" --destination ${remote} --prepared .workbench-ci/prepared/prepared.json --reports ${reports}`,
            ...authentication,
          },
          { ...upload("results-${{ fromJSON(inputs.platform).id }}-${{ matrix.id }}", `${reports}/`), if: "always()" },
          ...steps.after,
        ],
      },
    },
  });
}
function matrixOutput(path: string): string {
  return `node -e 'const fs=require("node:fs");fs.appendFileSync(process.env.GITHUB_OUTPUT,"matrix="+JSON.stringify(JSON.parse(fs.readFileSync("${path}","utf8")))+String.fromCharCode(10))'`;
}
function workflow(context: CIRenderContext, destination: CIDestination): string {
  if (destination.provider === CIProvider.GitLab) {
    const planner = context.groups[0];
    if (!planner) throw new Error("CI workflow requires at least one configured target");
    return stringify({
      stages: ["plan", "check"],
      variables: {
        GIT_DEPTH: "0",
        WORKBENCH_DATA_HOME: "$CI_PROJECT_DIR/.workbench-ci/data",
        WORKBENCH_STATE_HOME: "$CI_PROJECT_DIR/.workbench-ci/state",
      },
      workflow: {
        rules: [
          { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
          { if: "$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS", when: "never" },
          { if: "$CI_COMMIT_BRANCH" },
          { if: '$CI_PIPELINE_SOURCE == "web"' },
        ],
      },
      "workbench-plan": {
        stage: "plan",
        tags: runnerTags(destination, planner),
        timeout: "15m",
        script: [
          ...context.bootstrap,
          `${context.command} project add .`,
          `${context.command} ci pipeline --destination ${quote(destination.remote)} --output .workbench-ci/pipeline.yml`,
        ],
        artifacts: { paths: [".workbench-ci/pipeline.yml"], expire_in: "1 day" },
      },
      "workbench-checks": {
        stage: "check",
        trigger: { include: [{ artifact: ".workbench-ci/pipeline.yml", job: "workbench-plan" }], strategy: "mirror" },
      },
    });
  }
  const steps = githubSteps(context);
  return githubYAML(context, {
    name: "Workbench checks",
    on: { push: {}, pull_request: {}, workflow_dispatch: {} },
    permissions: { contents: "read", packages: "read" },
    env: { GH_TOKEN: "${{ github.token }}" },
    defaults: { run: { shell: "bash" } },
    jobs: {
      plan: {
        "runs-on": githubRunner("linux", "x64"),
        "timeout-minutes": 15,
        outputs: { matrix: "${{ steps.matrix.outputs.matrix }}" },
        steps: [
          ...steps.before,
          {
            run: `${context.command} ci pipeline --destination ${quote(destination.remote)} --output .workbench-ci/matrix.json`,
          },
          { id: "matrix", run: matrixOutput(".workbench-ci/matrix.json") },
        ],
      },
      platforms: {
        needs: ["plan"],
        strategy: { "fail-fast": false, matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}" },
        uses: `./${platformWorkflow}`,
        with: { platform: "${{ toJSON(matrix) }}", destination: destination.remote },
      },
    },
  });
}
export const renderCIWorkflow = (root: string, destination: CIDestination): string =>
  workflow(renderContext(root), destination);

export interface CISetupOptions {
  remote: string;
  provider?: CIProvider;
  registry?: string;
  repository?: string;
  registryManagement?: RegistryProvider | "none";
  registryApiHost?: string;
  registryProject?: string;
  plan?: boolean;
}
export function setupCI(root: string, options: CISetupOptions): void {
  const transport = remoteTransport(root, options.remote),
    config = readConfig(root);
  if (!config.ci) throw new Error("Configure [ci] operating_systems and environments before CI setup");
  const existingDestination = config.ci.destinations?.find((entry) => entry.remote === options.remote);
  const repository = options.repository
    ? repositoryIdentity(options.repository)
    : existingDestination?.transports?.some((alias) => repositoryTransport(alias) === repositoryTransport(transport))
      ? existingDestination.repository
      : repositoryIdentity(transport);
  const host = new URL(repository).hostname;
  const previous = existingDestination?.repository === repository ? existingDestination : undefined;
  const context = renderContext(root);
  const provider =
    options.provider ??
    previous?.provider ??
    (host === "github.com" ? CIProvider.GitHub : host === "gitlab.com" ? CIProvider.GitLab : undefined);
  if (!provider) throw new Error("Self-hosted CI requires --provider github or --provider gitlab");
  const destination: CIDestination = {
    remote: options.remote,
    provider,
    repository,
    ...(options.repository || previous?.transports?.length
      ? {
          transports: [
            ...new Set([...(previous?.transports?.map(repositoryTransport) ?? []), repositoryTransport(transport)]),
          ],
        }
      : {}),
    registries:
      options.registry || previous?.provider !== provider
        ? pairedRegistries(provider, repository, Object.keys(config.ci.images ?? {}), options.registry)
        : previous.registries,
    ...(previous?.runners ? { runners: previous.runners } : {}),
  };
  const destinations = readCIDestinations([
    ...(config.ci.destinations ?? []).filter((entry) => entry.remote !== options.remote),
    destination,
  ]);
  const edits = new ProjectEdits(root);
  const text = edits.read("workbench/config.toml") ?? "";
  const document = parse(text);
  const ci = document.ci as Record<string, unknown>;
  ci.destinations = destinations;
  const bindings = { ...(config.ci.registry_management ?? {}) };
  if ((options.registryApiHost || options.registryProject) && !options.registryManagement)
    throw new Error("Select --registry-management when declaring a registry API binding");
  if (options.registryManagement === "none" && (options.registryApiHost || options.registryProject))
    throw new Error("Transport-only registries have no API binding");
  if (options.registryManagement === RegistryProvider.GHCR && options.registryProject)
    throw new Error("GHCR management has no project field");
  for (const repository of Object.values(destination.registries)) {
    const provider =
      options.registryManagement ??
      (repository.startsWith("registry.gitlab.com/") && host === "gitlab.com" ? RegistryProvider.GitLab : undefined);
    if (provider === "none") bindings[repository] = { provider: "none" };
    else if (provider === RegistryProvider.GHCR)
      bindings[repository] = { provider, host: options.registryApiHost ?? "github.com" };
    else if (provider === RegistryProvider.GitLab) {
      const project = new URL(destination.repository);
      const host = options.registryApiHost ?? (destination.provider === CIProvider.GitLab ? project.host : undefined);
      const identity =
        options.registryProject ?? (destination.provider === CIProvider.GitLab ? project.pathname.slice(1) : undefined);
      if (!host || !identity)
        throw new Error("Registry management on another Git host requires --registry-api-host and --registry-project");
      bindings[repository] = { provider, host, project: identity };
    }
  }
  if (Object.keys(bindings).length) ci.registry_management = readRegistryManagement(bindings);
  edits.write("workbench/config.toml", editToml(text, document));
  const path = provider === CIProvider.GitHub ? ".github/workflows/workbench.yml" : ".gitlab-ci.yml";
  const generated = workflow(context, destination);
  const existing = edits.read(path);
  if (
    existing !== undefined &&
    existing !== generated &&
    (!existingDestination || existing !== workflow(context, existingDestination))
  )
    throw new Error(`${path} already exists; preserve or adapt that project-owned workflow before setup`);
  edits.write(path, generated);
  if (provider === CIProvider.GitHub) {
    const helper = githubPlatformWorkflow(context, destination),
      previousHelper = edits.read(platformWorkflow);
    if (
      previousHelper !== undefined &&
      previousHelper !== helper &&
      (!existingDestination || previousHelper !== githubPlatformWorkflow(context, existingDestination))
    )
      throw new Error(`${platformWorkflow} already exists; preserve that project-owned workflow before setup`);
    edits.write(platformWorkflow, helper);
    if (edits.read(".github/actionlint.yaml") === undefined && edits.read(".github/actionlint.yml") === undefined) {
      edits.write(
        ".github/actionlint.yaml",
        "# GitHub-hosted labels may precede actionlint's built-in catalog.\n# Extends lint recognition only; runners remain GitHub-hosted.\n# https://github.com/actions/runner-images#available-images\n" +
          stringify({
            "self-hosted-runner": { labels: Object.values(ciPlatforms).map((platform) => platform.github) },
          }),
      );
    }
  }
  const ignore = edits.read(".gitignore") ?? "";
  if (!ignore.split(/\r?\n/).includes("/.workbench-ci/"))
    edits.write(".gitignore", `${ignore.trimEnd()}\n/.workbench-ci/\n`);
  console.log(
    JSON.stringify(
      {
        destination,
        files: [...edits.files.keys()],
        runnerRequirements:
          provider === CIProvider.GitLab
            ? "Runner tags workbench-OS-ARCH (or ci.destinations runners overrides), with Node and Git; prepared image targets also require Docker and registry authentication."
            : "GitHub-hosted runners; registry authentication must permit reading declared private images.",
      },
      null,
      2,
    ),
  );
  if (!options.plan) edits.apply();
}

export function writeCIPipeline(root: string, remote: string, path: string, group?: string): void {
  const output = ownedPath(root, path);
  writeAtomic(output, renderCIPipeline(root, ciDestination(root, remote), group));
}
