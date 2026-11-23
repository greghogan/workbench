import { projectPaths } from "../../projects/project-paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { stringify, Document, visit, isScalar } from "yaml";
import { readText } from "../../runtime/files.js";
import { readConfig } from "../../projects/project-configuration.js";
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
import { plannedCIPackages } from "./ci-packages.js";
import { editToml } from "../../configuration/toml-edit.js";
import { ProjectEdits } from "../../projects/project-edits.js";
import { distributionRoot } from "../../projects/project-context.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { ownedPath } from "../../runtime/paths.js";
import { withConfigurationSnapshot } from "../../configuration/configuration-snapshot.js";
import { readCIActionPins, ciActionManifest } from "./support/ci-actions.mjs";
import { RegistryProvider, readRegistryManagement } from "../../artifacts/registry-management-contract.js";
import { readArtifactCatalog, type ArtifactPublicationRule } from "../../artifacts/artifact-catalog.js";
import { offlineProfile } from "../../artifacts/offline-profiles.js";
import { required } from "../../runtime/invariants.js";

const quote = (value: string, os = "linux") => `'${value.replaceAll("'", os === "windows" ? "''" : "'\\''")}'`;
const reports = ".workbench-ci/reports";
const branchPublicationReports = `${reports}/branch-publication`;
const branchTransfers = "workbench-branch-images";
const branchTransferDirectory = `"$RUNNER_TEMP/${branchTransfers}"`;
const gitlabBranchTransfers = ".workbench-ci/branch-transfers";
const branchPreparationJob = "prepare-branch-images";
const releaseTransfers = ".workbench-ci/release-transfers";
const verifiedPackages = ".workbench-ci/verified-packages";
const packageJob = (target: string) => `package-release-${target}`;
const platformWorkflow = ".github/workflows/workbench-platform.yml";
interface CIRenderContext {
  command: string;
  source: string;
  bootstrap: string[];
  node: string;
  actions: Record<string, { version: string; revision: string }>;
  groups: CIJobGroup[];
  packagePlatforms: ReadonlySet<string>;
  publication: { branch?: ArtifactPublicationRule; tag?: ArtifactPublicationRule };
  branchRegistry?: string;
}
function renderContext(root: string): CIRenderContext {
  return withConfigurationSnapshot(() => {
    const config = readConfig(root),
      directory = ".workbench-ci/tool",
      pin = config.tool;
    if (!pin && !existsSync(join(root, "bin/workbench.mjs")))
      throw new Error("CI setup requires a pinned Workbench executable in [tool]");
    const distribution = distributionRoot(root);
    const groups = ciJobGroups(root, ciTargets(root));
    const { publication, destinations } = readArtifactCatalog(root);
    const branch = publication.branch && destinations[publication.branch.destination];
    const nativePlatforms = new Set(
      groups
        .filter(({ environment }) => environment === "native")
        .map(({ os, architecture }) => `${os}-${architecture}`),
    );
    return {
      command: pin ? `node ${directory}/bin/workbench.mjs` : "node bin/workbench.mjs",
      source: pin ? directory : ".",
      bootstrap: pin
        ? [
            `git init ${quote(directory)}`,
            `git -C ${quote(directory)} remote add origin ${quote(pin.repository.replace(/^git\+/, "").replaceAll("'", "%27"))}`,
            `git -C ${quote(directory)} fetch --depth 1 origin ${quote(pin.revision)}`,
            `git -C ${quote(directory)} checkout --detach ${quote(pin.revision)}`,
            `node ${quote(directory + "/scripts/setup-development.mjs")} --build-only`,
          ]
        : existsSync(join(root, "scripts/setup-development.mjs"))
          ? ["node scripts/setup-development.mjs --build-only"]
          : [],
      node: readText(join(distribution, ".node-version")).trim(),
      actions: readCIActionPins(readText(join(distribution, ciActionManifest))),
      groups,
      packagePlatforms: new Set(plannedCIPackages(root, nativePlatforms).selected.map(({ row }) => row.platform)),
      publication,
      ...(branch?.kind === "registry" ? { branchRegistry: branch.repository } : {}),
    };
  });
}

function branchRegistry(context: CIRenderContext, destination: CIDestination): CIDestination {
  return { ...destination, registries: { native: required(context.branchRegistry, "Branch publication registry") } };
}

function verifiesPackages(context: CIRenderContext, group: CIJobGroup): boolean {
  return group.environment === "native" && context.packagePlatforms.has(`${group.os}-${group.architecture}`);
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
function githubSteps(context: CIRenderContext, destination?: CIDestination, loginBefore = true) {
  const login = destination ? registryLogin(destination, "linux") : [];
  const auth = login.length ? { DOCKER_CONFIG: "${{ runner.temp }}/workbench-docker-auth" } : {};
  const signIn = login.map((run) => ({
    run,
    if: "runner.os == 'Linux'",
    env: { ...auth, WORKBENCH_REGISTRY_TOKEN: "${{ github.token }}" },
  }));
  return {
    before: [
      {
        run: "git config --global core.autocrlf false\ngit config --global core.symlinks true\ngit config --global core.longpaths true",
      },
      { uses: action(context, "actions/checkout"), with: { "persist-credentials": false, "fetch-depth": 0 } },
      { uses: action(context, "actions/setup-node"), with: { "node-version": context.node } },
      { uses: action(context, "ilammy/msvc-dev-cmd"), if: "runner.os == 'Windows'" },
      ...(loginBefore ? signIn : []),
      ...[...context.bootstrap, `${context.command} project add .`].map((run) => ({ run })),
    ],
    auth,
    signIn,
    after: login.length
      ? [{ run: 'rm -rf -- "$DOCKER_CONFIG"', if: "always() && runner.os == 'Linux'", env: auth }]
      : [],
  };
}
function runnerTags(destination: CIDestination, group: CIJobGroup): string[] {
  return destination.runners?.[`${group.os}-${group.architecture}`] ?? [`workbench-${group.os}-${group.architecture}`];
}

function publicationRows(context: CIRenderContext) {
  return (["branch", "tag"] as const).flatMap((trigger) => {
    const rule = context.publication[trigger];
    if (!rule) return [];
    const targets = rule.targets.map(({ name, platform }) => {
      const group = context.groups.find(
        (item) => `${item.os}-${item.architecture}` === platform && item.environment === "native",
      );
      if (!group) throw new Error(`Publication target ${name} needs configured native ${platform} CI coverage`);
      return { name, group };
    });
    return [{ trigger, rule, targets }];
  });
}

function branchImageSelection(rule: ArtifactPublicationRule, target: string) {
  return `--target ${quote(target)} --kind ${quote(rule.kind)} --format oci`;
}

const requireBranchRevision = 'test "$(git rev-parse HEAD)" = "${GITHUB_SHA:-$CI_COMMIT_SHA}"';

function branchImageTransferCommands(
  context: CIRenderContext,
  rule: ArtifactPublicationRule,
  target: string,
  directory: string,
) {
  const selection = branchImageSelection(rule, target);
  return rule.profiles.map((profile) => {
    const output = `${directory}/${quote(profile)}`;
    return `${context.command} artifact build ${quote(profile)} ${selection} --export ${output} --json > ${output}.json`;
  });
}

function branchImageImportCommands(
  context: CIRenderContext,
  rule: ArtifactPublicationRule,
  target: string,
  directory: string,
) {
  const selection = branchImageSelection(rule, target);
  const readManifest = [
    "const [path, profile, target, kind] = process.argv.slice(1);",
    "const rows = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));",
    "const [row] = rows;",
    "const sha = row?.delivered?.manifestSha256;",
    "if (rows.length !== 1 || row.profile !== profile || row.kind !== kind || row.target !== target ||",
    "row.format !== 'oci' || row.delivered?.verification !== 'verified' || !/^[a-f0-9]{64}$/.test(sha))",
    "throw new Error('Invalid verified image transfer');",
    "console.log(sha);",
  ].join(" ");
  return rule.profiles.map((profile) => {
    const input = `${directory}/${quote(profile)}`;
    return (
      `digest=$(node -e ${quote(readManifest)} ${input}.json ${quote(profile)} ${quote(target)} ${quote(rule.kind)}) && ` +
      `${context.command} artifact import ${quote(profile)} ${input}/"image-$digest" ${selection} --sha256 "$digest"`
    );
  });
}

function branchPublicationCommands(context: CIRenderContext, rule: ArtifactPublicationRule, target: string) {
  const selection = branchImageSelection(rule, target);
  const describe = [
    "const { GITHUB_REF_NAME, GITHUB_SHA, CI_COMMIT_BRANCH, CI_COMMIT_SHA } = process.env;",
    "const [destination, target, kind] = process.argv.slice(1);",
    "const branch = GITHUB_REF_NAME || CI_COMMIT_BRANCH;",
    "const revision = GITHUB_SHA || CI_COMMIT_SHA;",
    "console.log(JSON.stringify({ branch, revision, destination, target, kind }, null, 2));",
  ].join(" ");
  return [
    requireBranchRevision,
    `mkdir -p ${quote(reports)} && mkdir ${quote(branchPublicationReports)}`,
    `node -e ${quote(describe)} ${quote(rule.destination)} ${quote(target)} ${quote(rule.kind)} > ${quote(`${branchPublicationReports}/channel.json`)}`,
    ...rule.profiles.map((profile) => {
      const report = quote(`${branchPublicationReports}/image-${profile}.json`);
      const pending = quote(`${branchPublicationReports}/image-${profile}.pending`);
      return (
        `${context.command} artifact publish ${quote(profile)} ${selection} --destination ${quote(rule.destination)} --json > ${pending}` +
        ` && mv ${pending} ${report}`
      );
    }),
  ];
}

function gitlabBranchRegistry(context: CIRenderContext) {
  const repository = required(context.branchRegistry, "Branch publication registry");
  return {
    check: [
      `destination=${quote(repository)}`,
      'if [ -n "${CI_REGISTRY_IMAGE:-}" ]; then',
      '  case "$destination" in',
      '    "$CI_REGISTRY_IMAGE"|"$CI_REGISTRY_IMAGE"/*)',
      "      printf '%s\\n' 'Branch publication needs a registry destination outside the source project. GitLab job tokens can push to the source project registry.' >&2",
      "      exit 1 ;;",
      "  esac",
      "fi",
    ].join("\n"),
    signIn: [
      ': "${WORKBENCH_PUBLISH_REGISTRY_USER:?Set the publishing registry user for this GitLab environment}"',
      ': "${WORKBENCH_PUBLISH_REGISTRY_PASSWORD:?Set the publishing registry password for this GitLab environment}"',
      "DOCKER_CONFIG=$(mktemp -d) && export DOCKER_CONFIG",
      "trap 'rm -rf -- \"$DOCKER_CONFIG\"' EXIT",
      `printf '%s' "$WORKBENCH_PUBLISH_REGISTRY_PASSWORD" | docker login ${quote(repository.split("/")[0] ?? "")} --username "$WORKBENCH_PUBLISH_REGISTRY_USER" --password-stdin`,
      "unset WORKBENCH_PUBLISH_REGISTRY_PASSWORD",
    ],
  };
}

const gitlabTag = (os: string) => (os === "windows" ? '"$env:CI_COMMIT_TAG"' : '"$CI_COMMIT_TAG"');

function packageReleaseCommand(context: CIRenderContext, target: string, os: string, tag: string, evidence?: string) {
  return (
    `${context.command} ci package-release ${quote(target, os)} --tag ${tag} --output ${quote(`${releaseTransfers}/${target}`, os)}` +
    (evidence ? ` --verified-packages ${quote(evidence, os)}` : "")
  );
}

function publishReleaseCommand(context: CIRenderContext, os: string, tag: string) {
  return `${context.command} ci publish-release --tag ${tag} --input ${quote(releaseTransfers, os)}`;
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
            verifyPackages: verifiesPackages(context, group),
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
    if (verifiesPackages(context, group)) {
      const directory = `${reports}/${group.id}/packages`;
      jobs[`verify-packages-${group.id}`] = {
        ...base,
        stage: "check",
        needs: [{ job: prepare, artifacts: false }],
        cache: { ...cache, policy: "pull" },
        script: [
          ...commands,
          `${context.command} ci verify-packages --tag=${gitlabTag(group.os)} --output ${quote(directory, group.os)}`,
        ],
        artifacts: { when: "always", paths: [`${directory}/`], expire_in: "14 days" },
      };
    }
  }
  const publication = publicationRows(context);
  for (const { trigger, rule, targets } of publication) {
    const { name, group } = required(targets[0], "Publication runner");
    const ref = trigger === "tag" ? "$CI_COMMIT_TAG" : "$CI_COMMIT_BRANCH";
    // Rule syntax is generated only from decoded Git ref names and optional trailing wildcards.
    const match = rule.refs
      .map((name) =>
        name.endsWith("*")
          ? `${ref} =~ /^${name.slice(0, -1).replaceAll(".", "\\.").replaceAll("/", "\\/")}/`
          : `${ref} == "${name}"`,
      )
      .join(" || ");
    const rules = [{ if: `$WORKBENCH_PARENT_SOURCE == "push" && $CI_MERGE_REQUEST_ID == null && (${match})` }];
    const preparation = [...context.bootstrap, `${context.command} project add .`];
    const registry = trigger === "branch" ? gitlabBranchRegistry(context) : undefined;
    if (!registry) {
      for (const { name: target, group: runner } of targets) {
        const checked = verifiesPackages(context, runner);
        jobs[packageJob(target)] = {
          stage: "package",
          tags: runnerTags(destination, runner),
          rules,
          dependencies: checked ? [`verify-packages-${runner.id}`] : [],
          timeout: "2h",
          script: [
            ...registryLogin(destination, runner.os),
            ...preparation,
            packageReleaseCommand(
              context,
              target,
              runner.os,
              gitlabTag(runner.os),
              checked ? `${reports}/${runner.id}/packages` : undefined,
            ),
          ],
          artifacts: { paths: [`${releaseTransfers}/${target}/`], expire_in: "1 day" },
        };
      }
    } else {
      jobs[branchPreparationJob] = {
        stage: "package",
        tags: runnerTags(destination, group),
        rules,
        dependencies: [],
        timeout: "2h",
        script: [
          requireBranchRevision,
          registry.check,
          ...registryLogin(destination, group.os),
          ...preparation,
          `mkdir -p .workbench-ci && mkdir ${quote(gitlabBranchTransfers)}`,
          ...branchImageTransferCommands(context, rule, name, quote(gitlabBranchTransfers)),
        ],
        artifacts: { access: "developer", paths: [`${gitlabBranchTransfers}/`], expire_in: "1 day" },
      };
    }
    const channel = `workbench-publication-${rule.destination}`;
    jobs[`publish-${trigger}`] = {
      stage: "publish",
      tags: runnerTags(destination, group),
      rules,
      resource_group: channel,
      timeout: "2h",
      script: [
        ...preparation,
        ...(registry
          ? [
              requireBranchRevision,
              registry.check,
              ...branchImageImportCommands(context, rule, name, quote(gitlabBranchTransfers)),
              ...registry.signIn,
              ...branchPublicationCommands(context, rule, name),
            ]
          : [publishReleaseCommand(context, group.os, gitlabTag(group.os))]),
      ],
      ...(registry
        ? {
            environment: { name: channel },
            needs: [{ job: branchPreparationJob, artifacts: true }],
            artifacts: { when: "always", paths: [`${branchPublicationReports}/*.json`], expire_in: "30 days" },
          }
        : {
            needs: targets.map(({ name: target }) => ({ job: packageJob(target), artifacts: true })),
            artifacts: { paths: ["**/workbench/releases/"], expire_in: "30 days" },
          }),
    };
  }
  return stringify({
    stages: [
      "prepare",
      "check",
      ...(publication.length ? ["package"] : []),
      ...(publication.length ? ["publish"] : []),
    ],
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
      packages: {
        ...common,
        if: "fromJSON(inputs.platform).verifyPackages",
        needs: ["prepare"],
        env: { WORKBENCH_CHECK_TAG: "${{ github.ref_type == 'tag' && github.ref_name || '' }}" },
        steps: [
          ...steps.before,
          cache,
          { run: prerequisites.run },
          {
            run: `${context.command} ci verify-packages --tag="$WORKBENCH_CHECK_TAG" --output ${reports}/packages`,
            ...authentication,
          },
          {
            ...upload("packages-${{ fromJSON(inputs.platform).id }}", `${reports}/packages/`),
            if: "always()",
          },
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
          ...(context.publication.tag ? [{ if: "$CI_COMMIT_TAG" }] : []),
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
        ...(publicationRows(context).length ? { variables: { WORKBENCH_PARENT_SOURCE: "$CI_PIPELINE_SOURCE" } } : {}),
        trigger: { include: [{ artifact: ".workbench-ci/pipeline.yml", job: "workbench-plan" }], strategy: "mirror" },
      },
    });
  }
  const steps = githubSteps(context);
  const publication = Object.fromEntries(
    publicationRows(context).flatMap<readonly [string, unknown]>(({ trigger, rule, targets }) => {
      const { name, group } = required(targets[0], "Publication runner");
      const refType = trigger === "tag" ? "refs/tags/" : "refs/heads/";
      const matches = rule.refs
        .map((name) =>
          name.endsWith("*")
            ? `startsWith(github.ref, '${refType}${name.slice(0, -1)}')`
            : `github.ref == '${refType}${name}'`,
        )
        .join(" || ");
      const condition = `github.event_name == 'push' && (${matches})`;
      const branch = trigger === "branch";
      const preparation = githubSteps(context, destination);
      const authenticated = githubSteps(context, branch ? branchRegistry(context, destination) : undefined, false);
      return [
        ...(trigger === "tag"
          ? targets.map(({ name: target, group: runner }) => {
              const checked = verifiesPackages(context, runner);
              return [
                packageJob(target),
                {
                  if: condition,
                  needs: ["platforms"],
                  "runs-on": githubRunner(runner.os, runner.architecture),
                  "timeout-minutes": 120,
                  permissions: { contents: "read", packages: "read" },
                  steps: [
                    ...preparation.before,
                    ...(checked
                      ? [
                          {
                            uses: action(context, "actions/download-artifact"),
                            with: { name: `packages-${runner.id}`, path: verifiedPackages },
                          },
                        ]
                      : []),
                    {
                      run: packageReleaseCommand(
                        context,
                        target,
                        "linux",
                        '"$GITHUB_REF_NAME"',
                        checked ? verifiedPackages : undefined,
                      ),
                      env: preparation.auth,
                    },
                    {
                      uses: action(context, "actions/upload-artifact"),
                      with: {
                        name: `release-transfer-${target}`,
                        path: `${releaseTransfers}/${target}/`,
                        "include-hidden-files": true,
                        "if-no-files-found": "error",
                      },
                    },
                    ...preparation.after,
                  ],
                },
              ] as const;
            })
          : [
              [
                branchPreparationJob,
                {
                  if: condition,
                  needs: ["platforms"],
                  "runs-on": githubRunner(group.os, group.architecture),
                  "timeout-minutes": 120,
                  permissions: { contents: "read", packages: "read" },
                  steps: [
                    ...preparation.before,
                    { run: requireBranchRevision },
                    { run: `mkdir ${branchTransferDirectory}` },
                    ...branchImageTransferCommands(context, rule, name, branchTransferDirectory).map((run) => ({
                      run,
                      env: preparation.auth,
                    })),
                    {
                      uses: action(context, "actions/upload-artifact"),
                      with: {
                        name: branchTransfers,
                        path: `\${{ runner.temp }}/${branchTransfers}`,
                        "if-no-files-found": "error",
                      },
                    },
                    ...preparation.after,
                  ],
                },
              ] as const,
            ]),
        [
          `publish-${trigger}`,
          {
            if: condition,
            needs: branch ? [branchPreparationJob] : targets.map(({ name: target }) => packageJob(target)),
            "runs-on": githubRunner(group.os, group.architecture),
            "timeout-minutes": 120,
            concurrency: { group: `workbench-publication-${rule.destination}`, "cancel-in-progress": false },
            permissions: {
              contents: trigger === "tag" ? "write" : "read",
              packages: trigger === "branch" ? "write" : "read",
            },
            ...(branch ? { env: { GH_TOKEN: "" } } : {}),
            steps: [
              ...authenticated.before,
              ...(trigger === "tag"
                ? [
                    ...targets.map(({ name: target }) => ({
                      uses: action(context, "actions/download-artifact"),
                      with: { name: `release-transfer-${target}`, path: `${releaseTransfers}/${target}` },
                    })),
                    { run: publishReleaseCommand(context, "linux", '"$GITHUB_REF_NAME"') },
                    {
                      uses: action(context, "actions/upload-artifact"),
                      with: { name: "published-release-record", path: "**/workbench/releases/" },
                    },
                  ]
                : [
                    { run: requireBranchRevision },
                    {
                      uses: action(context, "actions/download-artifact"),
                      with: { name: branchTransfers, path: `\${{ runner.temp }}/${branchTransfers}` },
                    },
                    ...branchImageImportCommands(context, rule, name, branchTransferDirectory).map((run) => ({ run })),
                    ...authenticated.signIn,
                    ...branchPublicationCommands(context, rule, name).map((run) => ({
                      run,
                      env: authenticated.auth,
                    })),
                    {
                      if: "always()",
                      uses: action(context, "actions/upload-artifact"),
                      with: { name: "published-branch-images", path: `${branchPublicationReports}/*.json` },
                    },
                  ]),
              ...authenticated.after,
            ],
          },
        ] as const,
      ];
    }),
  );
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
      ...publication,
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
        ? pairedRegistries(
            provider,
            repository,
            Object.entries(config.ci.images ?? {}).map(([builder, name]) => [
              builder,
              offlineProfile(root, name).offline.kind ?? "development",
            ]),
            options.registry,
          )
        : previous.registries,
    ...(previous?.runners ? { runners: previous.runners } : {}),
  };
  const destinations = readCIDestinations([
    ...(config.ci.destinations ?? []).filter((entry) => entry.remote !== options.remote),
    destination,
  ]);
  const edits = new ProjectEdits(root);
  const text = edits.read(projectPaths.config) ?? "";
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
  edits.write(projectPaths.config, editToml(text, document));
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
