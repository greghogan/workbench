import { RegistryProvider } from "../../../../src/core/artifacts/registry-management-contract.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { parse as yamlParse } from "yaml";
import { CIProvider, repositoryIdentity, readCIDestinations } from "../../../../src/core/execution/ci/ci-hosting.ts";
import { setupCI, renderCIWorkflow, renderCIPipeline } from "../../../../src/core/execution/ci/ci-workflows.ts";
import { ciDestination, pushCIDestinations } from "../../../../src/core/execution/ci/ci-destinations.ts";
import { readConfig } from "../../../../src/core/projects/project-configuration.ts";
import * as offlineProfiles from "../../../../src/core/artifacts/offline-profiles.ts";
import { ciJobGroups } from "../../../../src/core/execution/ci/ci-job-plan.ts";
import { operationPhases } from "../../../../src/core/execution/ci/support/ci-operations.mjs";
import { ciTargets } from "../../../../src/core/execution/ci/ci-targets.ts";
import { verifyCIImages } from "../../../../src/core/execution/ci/ci-images.ts";
import { registryImageStatus } from "../../../../src/core/artifacts/registry-images.ts";
import { record, records, string, strings } from "../../../../src/core/runtime/values.mjs";
vi.mock("../../../../src/core/artifacts/registry-images.ts", () => ({ registryImageStatus: vi.fn() }));
const roots: string[] = [];
const distribution = resolve(import.meta.dirname, "../../../../..");
beforeEach(() => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.mocked(registryImageStatus).mockResolvedValue({ state: "available" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-hosting-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, ".devcontainer"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="javascript"\npath="."\n',
  );
  writeFileSync(
    join(root, "workbench/config.toml"),
    `schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[ci]\noperating_systems=["linux","macos","windows"]\nenvironments=[]\n[ci.architectures]\nlinux=["x64","arm64"]\n[ci.images]\nnative="native"\n[[development.profiles]]\nname="native"\nbuilder="native"\nworkspace="host"\ncontainer_config=".devcontainer/config.json"\n[development.profiles.offline]\nregistry="ghcr.io/owner/project/development-native"\ninputs=["input.txt"]\nverify=["true"]\n[[check]]\nname="behavior"\nrole="test"\ncommand=["node","-e","process.exit(0)"]\nrequires_setup=false\n`,
  );
  writeFileSync(join(root, "bin/workbench.mjs"), "// Checkout launcher fixture.\n");
  const node = readFileSync(join(distribution, ".node-version"), "utf8").trim();
  writeFileSync(join(root, ".node-version"), node);
  writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: `>=${node}` } }));
  writeFileSync(join(root, "input.txt"), "declared preparation input\n");
  writeFileSync(
    join(root, ".devcontainer/config.json"),
    JSON.stringify({ image: `example.invalid/base@sha256:${"a".repeat(64)}` }),
  );
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("remote", "add", "origin", "git@github.com:Owner/Project.git");
  git("remote", "add", "gitlab", "ssh://git@gitlab.com/group/subgroup/project.git");
  return { root, git };
}
test.each([
  ["git@github.com:owner/repo.git", "https://github.com/owner/repo"],
  ["ssh://git@gitlab.example:2222/team/nested/repo.git", "https://gitlab.example/team/nested/repo"],
  ["https://gitlab.example:8443/team/repo.git", "https://gitlab.example:8443/team/repo"],
])("transport identity normalizes %s", (input, expected) => {
  expect(repositoryIdentity(input)).toBe(expected);
});
test.each([
  "https://user:secret@gitlab.com/team/repo.git",
  "https://gitlab.com/team/repo?token=secret",
  "file:///private/repo",
  "git@gitlab.com:team/repo\ncommand",
])("unsafe remote identities are rejected without including credentials: %s", (input) => {
  expect(() => repositoryIdentity(input)).toThrow();
  try {
    repositoryIdentity(input);
  } catch (error) {
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("command");
  }
});
test("setup previews without mutation, saves paired defaults and preserves an explicit registry override", () => {
  const { root } = fixture();
  const original = readFileSync(join(root, "workbench/config.toml"));
  setupCI(root, { remote: "gitlab", plan: true });
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(original);
  expect(existsSync(join(root, ".gitlab-ci.yml"))).toBe(false);
  setupCI(root, { remote: "gitlab" });
  setupCI(root, { remote: "origin" });
  expect(ciDestination(root, "origin").registries.native).toBe("ghcr.io/owner/project/development-native");
  expect(ciDestination(root, "gitlab").registries.native).toBe(
    "registry.gitlab.com/group/subgroup/project/development-native",
  );
  expect(readConfig(root).ci?.images).toEqual({ native: "native" });
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("/.workbench-ci/");
  setupCI(root, { remote: "gitlab", registry: "harbor.example/tools/project" });
  expect(ciDestination(root, "gitlab").registries.native).toBe("harbor.example/tools/project/development-native");
});
test("push selection follows the destination URL, including renamed aliases, and rejects a moved remote", () => {
  const { root, git } = fixture();
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  expect(
    pushCIDestinations(root, "renamed", "https://gitlab.com/group/subgroup/project.git").map((d) => d?.provider),
  ).toEqual([CIProvider.GitLab]);
  git("remote", "set-url", "gitlab", "git@gitlab.com:another/project.git");
  expect(() => pushCIDestinations(root, "gitlab")).toThrow(/no CI declaration/);
  expect(pushCIDestinations(root)).toHaveLength(2);
});
test("push manifest checks inspect only the selected destination and preserve the shared input identity", async () => {
  const { root } = fixture();
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  await verifyCIImages(root, "gitlab", "git@gitlab.com:group/subgroup/project.git");
  const gitlab = vi.mocked(registryImageStatus).mock.calls.map(([ref]) => ref);
  expect(gitlab).toHaveLength(2);
  expect(gitlab.every((ref) => ref.startsWith("registry.gitlab.com/group/subgroup/project/"))).toBe(true);
  vi.mocked(registryImageStatus).mockClear();
  await verifyCIImages(root, "origin", "git@github.com:Owner/Project.git");
  expect(vi.mocked(registryImageStatus).mock.calls.map(([ref]) => ref.slice(ref.lastIndexOf(":") + 1))).toEqual(
    gitlab.map((ref) => ref.slice(ref.lastIndexOf(":") + 1)),
  );
});

test("CI planning and push checks require the catalog's OCI variant for every selected Linux architecture", async () => {
  const { root } = fixture();
  const config = join(root, "workbench/config.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace('native="native"', 'native="ci-tools"') +
      `
[[development.profiles]]
name="ci-tools"
builder="native"
workspace="host"
container_config=".devcontainer/config.json"
[development.profiles.offline]
kind="toolchain"
registry="ghcr.io/owner/project/toolchain-native"
inputs=["input.txt"]
verify=["true"]
`,
  );
  const catalog = join(root, "workbench/profiles.toml");
  const variant = (target: string) => `{target="${target}",kind="toolchain",recipe="tools",formats=["oci"]}`;
  const declare = (targets: string[]) => {
    writeFileSync(
      catalog,
      `schema_version=1
[targets.linux-x64]
platform="linux-x64"
[targets.linux-arm64]
platform="linux-arm64"
[recipes.tools]
owner="app"
offline_profile="ci-tools"
[profiles.native]
builder="native"
projects=["app"]
variants=[${targets.map(variant).join(",")}]
`,
    );
  };
  declare(["linux-x64"]);
  expect(() => ciJobGroups(root)).toThrow(/ci-tools.*toolchain OCI artifact for linux-arm64/);
  await expect(verifyCIImages(root)).rejects.toThrow(/ci-tools.*linux-arm64/);
  expect(registryImageStatus).not.toHaveBeenCalled();

  declare(["linux-x64", "linux-arm64"]);
  const valid = readFileSync(catalog, "utf8");
  writeFileSync(catalog, valid.replace('kind="toolchain"', 'kind="development"'));
  expect(() => ciJobGroups(root)).toThrow(/recipe 'tools' selects a native toolchain profile/);
  writeFileSync(catalog, valid);
  expect(
    ciJobGroups(root)
      .filter((group) => group.os === "linux")
      .map(({ architecture, profile }) => ({ architecture, profile })),
  ).toEqual([
    { architecture: "x64", profile: "ci-tools" },
    { architecture: "arm64", profile: "ci-tools" },
  ]);
  await verifyCIImages(root);
  expect(vi.mocked(registryImageStatus).mock.calls.map(([reference]) => reference)).toEqual([
    offlineProfiles.offlineImageReference(root, "ci-tools", "x64"),
    offlineProfiles.offlineImageReference(root, "ci-tools", "arm64"),
  ]);
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  expect(ciDestination(root, "origin").registries.native).toBe("ghcr.io/owner/project/toolchain-native");
  expect(ciDestination(root, "gitlab").registries.native).toBe(
    "registry.gitlab.com/group/subgroup/project/toolchain-native",
  );
});

test("both pipeline adapters preserve every configured phase exactly once with one preparation dependency per group", () => {
  const { root } = fixture();
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  const targets = ciTargets(root),
    groups = ciJobGroups(root);
  const github = record(JSON.parse(renderCIPipeline(root, ciDestination(root, "origin"))), "matrix");
  expect(records(github.include, "matrix").map((row) => row.id)).toEqual(groups.map((group) => group.id));
  const expected = targets.flatMap((target) => target.phases.map((phase) => JSON.stringify([target.id, phase]))).sort();
  const actual = groups
    .flatMap((group) =>
      group.jobs.flatMap((job) =>
        job.targets.flatMap((target) =>
          operationPhases(target, job.operation).map((phase) => JSON.stringify([target.id, phase])),
        ),
      ),
    )
    .sort();
  expect(actual).toEqual(expected);
  const destination = ciDestination(root, "gitlab");
  destination.runners = { "linux-x64": ["custom-linux", "x64"] };
  const gitlab = record(yamlParse(renderCIPipeline(root, destination)), "pipeline");
  for (const group of groups) {
    expect(record(gitlab[`prepare-${group.id}`], "preparation").stage).toBe("prepare");
    for (const job of group.jobs) {
      const rendered = record(gitlab[`check-${group.id}-${job.artifact}`], "job");
      expect(rendered.needs).toEqual([{ job: `prepare-${group.id}`, artifacts: true }]);
      expect(record(rendered.artifacts, "artifacts").when).toBe("always");
      expect(rendered.tags).toEqual(
        destination.runners[`${group.os}-${group.architecture}`] ?? [`workbench-${group.os}-${group.architecture}`],
      );
    }
    expect(
      records(
        record(JSON.parse(renderCIPipeline(root, destination, group.id)), "operations").include,
        "operations",
      ).map((row) => row.id),
    ).toEqual(group.jobs.map((job) => job.artifact));
  }
  const workflow = record(yamlParse(renderCIWorkflow(root, destination)), "workflow");
  expect(record(record(workflow["workbench-checks"], "child").trigger, "trigger").strategy).toBe("mirror");
});
test("self-hosted setup is explicit and existing project-owned workflows are preserved", () => {
  const { root, git } = fixture();
  git("remote", "set-url", "gitlab", "git@git.example:team/project.git");
  expect(() => {
    setupCI(root, { remote: "gitlab" });
  }).toThrow(/--provider/);
  expect(() => {
    setupCI(root, { remote: "gitlab", provider: CIProvider.GitLab });
  }).toThrow(/--registry/);
  writeFileSync(join(root, ".gitlab-ci.yml"), "# Existing team workflow\n");
  const config = readFileSync(join(root, "workbench/config.toml"));
  expect(() => {
    setupCI(root, { remote: "gitlab", provider: CIProvider.GitLab, registry: "registry.example/team/project" });
  }).toThrow(/already exists/);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(config);
  expect(readFileSync(join(root, ".gitlab-ci.yml"), "utf8")).toBe("# Existing team workflow\n");
  expect(() =>
    readCIDestinations([{ remote: "gitlab", provider: "other", repository: "https://git.example/team/project" }]),
  ).toThrow(/provider/);
});

test("GitHub matrix output is executable shell with a complete JSON line, and workflow components are immutable", () => {
  const { root } = fixture();
  setupCI(root, { remote: "origin" });
  const destination = ciDestination(root, "origin");
  const workflow = record(yamlParse(renderCIWorkflow(root, destination)), "workflow");
  const jobs = record(workflow.jobs, "jobs");
  const plan = record(jobs.plan, "plan");
  const matrix = JSON.parse(renderCIPipeline(root, destination)) as unknown;
  mkdirSync(join(root, ".workbench-ci"));
  writeFileSync(join(root, ".workbench-ci/matrix.json"), JSON.stringify(matrix));
  const step = records(plan.steps, "steps").find((step) => step.id === "matrix");
  const result = spawnSync("bash", ["-eu", "-c", String(step?.run)], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: join(root, "output") },
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(join(root, "output"), "utf8")).toBe(`matrix=${JSON.stringify(matrix)}\n`);
  const platform = record(
    yamlParse(readFileSync(join(root, ".github/workflows/workbench-platform.yml"), "utf8")),
    "platform",
  );
  for (const job of [plan, ...Object.values(record(platform.jobs, "platform jobs"))])
    for (const step of records(record(job, "job").steps, "steps"))
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
});

test("publication triggers are opt-in and generated jobs run after checks with their own ref filters", () => {
  const { root } = fixture();
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/setup-development.mjs"), "// Source checkout bootstrap.\n");
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  const github = ciDestination(root, "origin");
  const gitlab = ciDestination(root, "gitlab");
  expect(renderCIWorkflow(root, github)).not.toContain("publish-tag:");
  expect(renderCIPipeline(root, gitlab)).not.toContain("publish-branch:");
  writeFileSync(
    join(root, "workbench/profiles.toml"),
    `
schema_version = 1
[targets.linux]
platform = "linux-x64"
[targets.arm]
platform = "linux-arm64"
[recipes.image]
owner = "app"
offline_profile = "native"
[recipes.files]
owner = "app"
inputs = ["input.txt"]
build = ["true"]
verify = ["true"]
[profiles.native]
builder = "native"
projects = ["app"]
variants = [
  { target = "linux", kind = "development", formats = ["oci"], recipe = "image" },
  { target = "arm", kind = "development", formats = ["oci"], recipe = "image" },
  { target = "linux", kind = "release", formats = ["archive"], recipe = "files" },
  { target = "arm", kind = "release", formats = ["archive"], recipe = "files" },
]
[destinations.images]
kind = "registry"
repository = "ghcr.io/owner/project/branch"
[destinations.releases]
kind = "github"
repository = "Owner/Project"
[publication.branch]
refs = ["main", "release/*"]
profiles = ["native"]
kind = "development"
target = "linux"
destination = "images"
[publication.tag]
refs = ["v*"]
profiles = ["native"]
targets = ["linux", "arm"]
destination = "releases"
`,
  );
  const host = record(yamlParse(renderCIWorkflow(root, github)), "GitHub workflow");
  const jobs = record(host.jobs, "GitHub jobs");
  const matrix = record(JSON.parse(renderCIPipeline(root, github)), "GitHub matrix");
  expect(
    records(matrix.include, "platforms")
      .filter(({ verifyPackages }) => verifyPackages)
      .map(({ id }) => id),
  ).toEqual(["linux-x64-native", "linux-arm64-native"]);
  const platform = record(
    yamlParse(readFileSync(join(root, ".github/workflows/workbench-platform.yml"), "utf8")),
    "Generated platform workflow",
  );
  const packages = record(record(platform.jobs, "Platform jobs").packages, "Native package job");
  expect(packages.if).toBe("fromJSON(inputs.platform).verifyPackages");
  expect(records(packages.steps, "Package steps").some(({ run }) => String(run).includes("ci verify-packages"))).toBe(
    true,
  );
  const branch = record(jobs["publish-branch"], "branch publication");
  expect(branch.if).toContain("refs/heads/release/");
  expect(branch).toMatchObject({
    needs: ["prepare-branch-images"],
    permissions: { packages: "write", contents: "read" },
    env: { GH_TOKEN: "" },
  });
  const branchPreparation = record(jobs["prepare-branch-images"], "branch image preparation");
  expect(branchPreparation).toMatchObject({
    if: branch.if,
    needs: ["platforms"],
    permissions: { contents: "read", packages: "read" },
  });
  const preparationSteps = records(branchPreparation.steps, "Branch preparation steps");
  expect(preparationSteps.flatMap(({ run }) => (String(run).includes("node ") ? [run] : [])).slice(0, 2)).toEqual([
    "node scripts/setup-development.mjs --build-only",
    "node bin/workbench.mjs project add .",
  ]);
  expect(branchPreparation.env).toBeUndefined();
  const imageBuildStep = preparationSteps.find(({ run }) => String(run).includes("artifact build"));
  expect(imageBuildStep?.run).toContain("--format oci --export");
  expect(imageBuildStep?.env).toEqual({ DOCKER_CONFIG: "${{ runner.temp }}/workbench-docker-auth" });
  const transfer = { name: "workbench-branch-images", path: "${{ runner.temp }}/workbench-branch-images" };
  expect(preparationSteps).toContainEqual(
    expect.objectContaining({ with: { ...transfer, "if-no-files-found": "error" } }),
  );
  const branchReports = ".workbench-ci/reports/branch-publication";
  const branchSteps = records(branch.steps, "Branch publication steps");
  expect(branchSteps).toContainEqual(expect.objectContaining({ with: transfer }));
  const work = branchSteps.flatMap(
    ({ run }) => /artifact (build|import|publish)|docker login/.exec(String(run))?.[0] ?? [],
  );
  expect(work).toEqual(["artifact import", "docker login", "artifact publish"]);
  if (process.platform === "linux") {
    const command = string(
      branchSteps.find(({ run }) => String(run).includes("artifact import"))?.run,
      "Image import step",
    );
    const temp = join(root, "runner temp");
    const images = join(temp, "workbench-branch-images");
    const digest = "f".repeat(64);
    const args = join(temp, "import-arguments.json");
    mkdirSync(images, { recursive: true });
    writeFileSync(
      join(root, "bin/workbench.mjs"),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const runImport = (verification: "verified" | "unverified") => {
      writeFileSync(
        join(images, "native.json"),
        JSON.stringify([
          {
            profile: "native",
            target: "linux",
            kind: "development",
            format: "oci",
            delivered: { directory: "/build-host/only", manifestSha256: digest, verification },
          },
        ]),
      );
      return spawnSync("bash", ["-e", "-c", command], { cwd: root, env: { ...process.env, RUNNER_TEMP: temp } });
    };
    expect(runImport("unverified").status).toBe(1);
    expect(existsSync(args)).toBe(false);
    expect(runImport("verified").status).toBe(0);
    expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([
      "artifact",
      "import",
      "native",
      join(images, "native", `image-${digest}`),
      "--target",
      "linux",
      "--kind",
      "development",
      "--format",
      "oci",
      "--sha256",
      digest,
    ]);
  }
  expect(branchSteps.find(({ run }) => String(run).includes("artifact publish"))?.run).toContain(
    `--json > '${branchReports}/image-native.pending' && mv '${branchReports}/image-native.pending' '${branchReports}/image-native.json'`,
  );
  expect(branchSteps).toContainEqual(
    expect.objectContaining({
      if: "always()",
      with: { name: "published-branch-images", path: `${branchReports}/*.json` },
    }),
  );
  const tag = record(jobs["publish-tag"], "tag publication");
  expect(tag.if).toContain("refs/tags/v");
  expect(tag).toMatchObject({
    needs: ["package-release-linux", "package-release-arm"],
    permissions: { contents: "write", packages: "read" },
  });
  for (const [target, runner] of [
    ["linux", "ubuntu-26.04"],
    ["arm", "ubuntu-26.04-arm"],
  ] as const) {
    const build = record(jobs[`package-release-${target}`], "target packaging");
    expect(build).toMatchObject({
      if: tag.if,
      "runs-on": runner,
      needs: ["platforms"],
      permissions: { contents: "read", packages: "read" },
    });
    const upload = records(build.steps, "build steps").find((step) =>
      String(step.uses).startsWith("actions/upload-artifact@"),
    );
    expect(upload?.with).toMatchObject({ name: `release-transfer-${target}` });
    expect(records(build.steps, "build steps").map((step) => step.with)).toContainEqual({
      name: `packages-linux-${target === "linux" ? "x64" : "arm64"}-native`,
      path: ".workbench-ci/verified-packages",
    });
    const download = records(tag.steps, "publisher steps").filter((step) =>
      String(step.uses).startsWith("actions/download-artifact@"),
    );
    expect(download.map((step) => step.with)).toContainEqual({
      name: `release-transfer-${target}`,
      path: `.workbench-ci/release-transfers/${target}`,
    });
  }
  const child = record(yamlParse(renderCIPipeline(root, gitlab)), "GitLab child workflow");
  expect(child.stages).toEqual(["prepare", "check", "package", "publish"]);
  expect(child["verify-packages-linux-arm64-native"]).toMatchObject({
    stage: "check",
    tags: ["workbench-linux-arm64"],
    needs: [{ job: "prepare-linux-arm64-native", artifacts: false }],
  });
  const childBranch = record(child["publish-branch"], "publish-branch");
  const prepareBranch = record(child["prepare-branch-images"], "GitLab branch preparation");
  expect(prepareBranch).toMatchObject({
    stage: "package",
    rules: childBranch.rules,
    artifacts: { access: "developer", paths: [".workbench-ci/branch-transfers/"], expire_in: "1 day" },
  });
  expect(childBranch).toMatchObject({
    environment: { name: "workbench-publication-images" },
    needs: [{ job: "prepare-branch-images", artifacts: true }],
  });
  const gitlabPrepare = strings(prepareBranch.script, "GitLab preparation script");
  const gitlabPublish = strings(childBranch.script, "GitLab publication script");
  expect(gitlabPrepare.some((command) => command.includes("artifact build") && command.includes("--export"))).toBe(
    true,
  );
  expect(gitlabPrepare.join("\n")).not.toContain("WORKBENCH_PUBLISH_REGISTRY_PASSWORD");
  expect(
    gitlabPublish.flatMap((command) => /artifact (build|import|publish)|docker login/.exec(command)?.[0] ?? []),
  ).toEqual(["artifact import", "docker login", "artifact publish"]);
  if (process.platform === "linux") {
    const registryGuard = string(
      gitlabPrepare.find((command) => command.includes("CI_REGISTRY_IMAGE")),
      "GitLab registry ownership guard",
    );
    const check = (CI_REGISTRY_IMAGE: string) =>
      spawnSync("bash", ["-e", "-c", registryGuard], { env: { ...process.env, CI_REGISTRY_IMAGE } });
    expect(check("ghcr.io/owner/project").status).toBe(1);
    expect(check("ghcr.io/owner/project-source").status).toBe(0);
  }
  expect(childBranch.artifacts).toMatchObject({ when: "always", paths: [`${branchReports}/*.json`] });
  const rules = records(childBranch.rules, "publish rules");
  expect(rules[0]?.if).toContain('WORKBENCH_PARENT_SOURCE == "push"');
  const publisher = record(child["publish-tag"], "publish-tag");
  expect(publisher).toMatchObject({
    needs: [
      { job: "package-release-linux", artifacts: true },
      { job: "package-release-arm", artifacts: true },
    ],
  });
  expect(publisher.script).toContain(
    "node bin/workbench.mjs ci publish-release --tag \"$CI_COMMIT_TAG\" --input '.workbench-ci/release-transfers'",
  );
  expect(child["package-release-arm"]).toMatchObject({
    stage: "package",
    dependencies: ["verify-packages-linux-arm64-native"],
    rules: publisher.rules,
    tags: ["workbench-linux-arm64"],
    artifacts: { paths: [".workbench-ci/release-transfers/arm/"] },
  });
  expect(record(child["package-release-arm"], "package-release-arm").needs).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "GitLab job credentials are isolated, cleaned up, and never replace runner credentials",
  () => {
    const { root } = fixture();
    setupCI(root, { remote: "gitlab" });
    const jobs = record(yamlParse(renderCIPipeline(root, ciDestination(root, "gitlab"))), "pipeline");
    const scripts = Object.entries(jobs)
      .filter(([name]) => name.startsWith("check-"))
      .flatMap(([, job]) => strings(record(job, "job").script, "script"));
    const login = scripts.find((line) => line.includes("docker login"));
    expect(login).toBeDefined();
    const commands = join(root, "commands");
    mkdirSync(commands);
    const docker = join(commands, "docker");
    writeFileSync(
      docker,
      '#!/bin/sh\ncat > "$DOCKER_CONFIG/config.json"\nprintf "%s" "$DOCKER_CONFIG" > "$AUTH_RESULT"\n',
    );
    chmodSync(docker, 0o755);
    const user = join(root, "user-docker");
    mkdirSync(user);
    writeFileSync(join(user, "config.json"), "preserved runner credentials");
    const result = spawnSync("bash", ["-eu", "-c", String(login)], {
      cwd: root,
      env: {
        ...process.env,
        PATH: commands + ":" + (process.env.PATH ?? ""),
        DOCKER_CONFIG: user,
        CI_REGISTRY: "registry.gitlab.com",
        CI_REGISTRY_USER: "fixture",
        CI_REGISTRY_PASSWORD: "fixture-token",
        AUTH_RESULT: join(root, "auth-result"),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const temporary = readFileSync(join(root, "auth-result"), "utf8");
    expect(temporary).not.toBe(user);
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(join(user, "config.json"), "utf8")).toBe("preserved runner credentials");
    expect(result.stdout + result.stderr).not.toContain("fixture-token");
  },
);

test("reconfiguring a moved remote selects its new provider and registry defaults", () => {
  const { root, git } = fixture();
  setupCI(root, { remote: "origin" });
  git("remote", "set-url", "origin", "git@gitlab.com:team/replacement.git");
  setupCI(root, { remote: "origin" });
  expect(ciDestination(root, "origin")).toMatchObject({
    provider: CIProvider.GitLab,
    repository: "https://gitlab.com/team/replacement",
    registries: { native: "registry.gitlab.com/team/replacement/development-native" },
  });
});
test("GitLab planning uses a configured native runner instead of requiring an extra Linux runner", () => {
  const { root } = fixture();
  const path = join(root, "workbench/config.toml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('operating_systems=["linux","macos","windows"]', 'operating_systems=["macos"]'),
  );
  setupCI(root, { remote: "gitlab" });
  const workflow = record(yamlParse(readFileSync(join(root, ".gitlab-ci.yml"), "utf8")), "workflow");
  expect(record(workflow["workbench-plan"], "plan").tags).toEqual(["workbench-macos-arm64"]);
});

test("explicit SSH transport bindings preserve aliases and ports independently of the API project identity", () => {
  const { root, git } = fixture();
  git("remote", "set-url", "gitlab", "ssh://git@work-alias:2222/team/project.git");
  setupCI(root, {
    remote: "gitlab",
    provider: CIProvider.GitLab,
    repository: "https://gitlab.example:8443/team/project",
    registry: "harbor.example/team/project",
  });
  expect(ciDestination(root, "gitlab")).toMatchObject({
    repository: "https://gitlab.example:8443/team/project",
    transports: ["ssh://git@work-alias:2222/team/project"],
  });
  const file = join(root, "workbench/config.toml");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "ssh://git@work-alias:2222/team/project",
      "ssh://git@work-alias:2222/team/project.git",
    ),
  );
  expect(pushCIDestinations(root, "renamed", "ssh://git@work-alias:2222/team/project.git")[0]?.remote).toBe("gitlab");
  expect(pushCIDestinations(root, "renamed", "https://gitlab.example:8443/team/project.git")[0]?.remote).toBe("gitlab");
  expect(() => pushCIDestinations(root, "renamed", "ssh://git@work-alias:2223/team/project.git")).toThrow(
    /no CI declaration/,
  );
  setupCI(root, { remote: "gitlab" });
  expect(ciDestination(root, "gitlab").repository).toBe("https://gitlab.example:8443/team/project");
});

test("manifest verification hashes each unique profile/platform once across roots and destinations", async () => {
  const { root } = fixture();
  setupCI(root, { remote: "origin" });
  setupCI(root, { remote: "gitlab" });
  const computed = vi.spyOn(offlineProfiles, "offlineImageReference");
  await verifyCIImages(root);
  expect(computed.mock.calls.map(([, name, architecture]) => [name, architecture]).sort()).toEqual([
    ["native", "arm64"],
    ["native", "x64"],
  ]);
  expect(vi.mocked(registryImageStatus).mock.calls).toHaveLength(4);
});

test("setup binds cross-host registry management only with an explicit API identity", () => {
  const { root } = fixture();
  expect(() => {
    setupCI(root, {
      remote: "origin",
      registry: "registry.gitlab.example/team/project",
      registryManagement: RegistryProvider.GitLab,
    });
  }).toThrow(/registry-api-host/);
  setupCI(root, {
    remote: "origin",
    registry: "registry.gitlab.example/team/project",
    registryManagement: RegistryProvider.GitLab,
    registryApiHost: "gitlab.example:8443",
    registryProject: "independent/project",
  });
  expect(readConfig(root).ci?.registry_management?.["registry.gitlab.example/team/project/development-native"]).toEqual(
    { provider: "gitlab", host: "gitlab.example:8443", project: "independent/project" },
  );
});
