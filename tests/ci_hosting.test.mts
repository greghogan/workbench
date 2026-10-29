import { RegistryProvider } from "../src/registry-management-contract.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { parse as yamlParse } from "yaml";
import { CIProvider, repositoryIdentity, readCIDestinations } from "../src/ci-hosting.ts";
import { setupCI, renderCIWorkflow, renderCIPipeline } from "../src/ci-workflows.ts";
import { ciDestination, pushCIDestinations } from "../src/ci-destinations.ts";
import { readConfig } from "../src/project-configuration.ts";
import * as offlineProfiles from "../src/offline-profiles.ts";
import { ciJobGroups } from "../src/ci-job-plan.ts";
import { operationPhases } from "../scripts/ci-operations.mjs";
import { ciTargets } from "../src/ci-targets.ts";
import { verifyCIImages } from "../src/ci-images.ts";
import { registryImageStatus } from "../src/registry-images.ts";
import { record, records, strings } from "../scripts/values.mjs";
vi.mock("../src/registry-images.ts", () => ({ registryImageStatus: vi.fn() }));
const roots: string[] = [];
const distribution = resolve(import.meta.dirname, "..");
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
