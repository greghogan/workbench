import { promised } from "./fixtures/promised.mjs";
import { configFromData } from "../src/project-configuration.ts";
import { required } from "../src/invariants.ts";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  offlineProfile,
  withOfflineProfileLock,
  offlineInputs,
  offlineImageReference,
  offlineReceiptPath,
  preparedOfflineProfile,
  validateOfflineDefinition,
  prepareOfflineProfile,
  verifyOfflineProfile,
  publishOfflineProfile,
  inspectOfflineImages,
  executePreparedProfile,
} from "../src/offline-profiles.ts";
import * as preparedImages from "../src/prepared-images.ts";
import { validateDevelopmentProfiles, type DevelopmentProfile } from "../src/profile-schema.ts";
import { validateConfig } from "../src/config-schema.ts";

const linuxTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));

interface OfflineState {
  tools: string;
  calls: unknown[][];
  platform: string;
  fail: string;
  config: Record<string, unknown>;
  onBuild: (() => void) | undefined;
  afterSnapshot: ((destination: string) => void) | undefined;
  recipeEnvironment: NodeJS.ProcessEnv | undefined;
  image: string;
  target: string;
  digest: string;
  daemon: string;
  policy: string;
  tree: string | undefined;
  binfmtUnavailable: boolean;
  guestMachine: string | undefined;
}
const state = vi.hoisted((): OfflineState => ({
  tools: "",
  calls: [],
  platform: "amd64",
  fail: "",
  config: {},
  onBuild: undefined,
  afterSnapshot: undefined,
  recipeEnvironment: undefined,
  image: `sha256:${"a".repeat(64)}`,
  target: "ghcr.io/example/offline:test",
  digest: `ghcr.io/example/offline@sha256:${"b".repeat(64)}`,
  daemon: "",
  policy: "fixture-policy",
  tree: undefined,
  binfmtUnavailable: false,
  guestMachine: undefined,
}));
vi.mock("../scripts/network-command.mts", () => ({
  acquireCommand: vi.fn<typeof import("../scripts/network-command.mts").acquireCommand>(
    async (_operation, command, args, options) => {
      const { executeCI } = await import("../scripts/ci-lifecycle.mjs");
      return executeCI(command, args, { ...options, capture: true });
    },
  ),
}));
vi.mock("../src/policy-compatibility.js", () => ({ policyCompatibility: () => ({ digest: state.policy }) }));
vi.mock("../src/image-emulation.js", () => ({ profileRequiresBinfmt: () => state.binfmtUnavailable }));
vi.mock("../src/image-finalization.js", () => ({
  finalizeImage: vi.fn<typeof import("../src/image-finalization.js").finalizeImage>((source, target) =>
    promised(() => {
      state.calls.push(["finalize", source, target]);
    }),
  ),
}));
vi.mock("../src/buildkit.js", () => ({
  currentBuildkitCacheKeys: () => [],
  withProjectBuilder: vi.fn<typeof import("../src/buildkit.js").withProjectBuilder>(async (_root, action) =>
    action({ name: "fixture", docker: "/fixture/docker", env: {} }),
  ),
  buildProjectImage: vi.fn<typeof import("../src/buildkit.js").buildProjectImage>(async (_root, args) => {
    const { executeCI } = await import("../scripts/ci-lifecycle.mjs");
    await executeCI("docker", ["build", ...args]);
  }),
}));
vi.mock("../src/native-tools.js", () => ({
  nativeEnvironment: () => process.env,
}));
vi.mock("../src/container-tools.js", () => ({
  containerCLI: () => {
    if (!existsSync(join(state.tools, "node_modules/@devcontainers/cli/package.json")))
      throw new Error("Install the locked Dev Container CLI with workbench tools install --devcontainer");
    return join(state.tools, "node_modules/@devcontainers/cli/cli.js");
  },
}));
vi.mock("../src/container-startup.js", () => ({
  validateContainerOwnership: vi.fn<typeof import("../src/container-startup.js").validateContainerOwnership>(),
  containerStartup: vi.fn<typeof import("../src/container-startup.js").containerStartup>((...args) =>
    promised(() => {
      state.calls.push(["build", ...args]);
      state.onBuild?.();
      return "{}";
    }),
  ),
}));
vi.mock("../src/ci-workspace.js", () => ({
  snapshotCIProject: vi.fn<typeof import("../src/ci-workspace.js").snapshotCIProject>((root, destination) =>
    promised(() => {
      cpSync(root, destination, { recursive: true });
      state.afterSnapshot?.(destination);
      return state.tree ? [{ path: ".", tree: state.tree }] : [];
    }),
  ),
}));
vi.mock("../scripts/ci-lifecycle.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/ci-lifecycle.mjs")>()),
  CILifecycle: class {
    checkpoint() {
      return Promise.resolve();
    }
    close() {
      return;
    }
  },
  executeCI: vi.fn<typeof import("../scripts/ci-lifecycle.mjs").executeCI>((command, args, options) =>
    promised(() => {
      state.calls.push([command, ...args]);
      if (command === "assemble-managed") state.recipeEnvironment = options?.env;
      if (state.fail && args.includes(state.fail)) throw new Error("selected failure");
      if (command === "node") return JSON.stringify({ configuration: state.config });
      if (command === "docker" && args[0] === "info")
        return args.includes("{{.Architecture}}") ? (process.arch === "arm64" ? "aarch64" : "x86_64") : state.daemon;
      if (command === "git") return "frozen-head";
      if (command === "docker" && args[0] === "exec" && args.at(-2) === "uname" && args.at(-1) === "-m")
        return state.guestMachine ?? (state.platform === "amd64" ? "x86_64" : "aarch64");
      if (args[0] === "image" && args[1] === "inspect") {
        if (
          (args.at(-1) === state.target && !args.includes("{{json .RepoDigests}}")) ||
          args[2]?.startsWith("workbench-prepared-")
        )
          throw new Error("No such image");
        if (args.includes("{{json .RepoDigests}}")) return JSON.stringify([state.digest]);
        if (args.includes("{{.Id}}")) return state.image;
        return JSON.stringify({
          Os: "linux",
          Architecture: state.platform,
          Config: {
            Labels: {
              "org.workbench.inputs": offlineInputs(
                root,
                offlineProfile(root, "offline"),
                state.platform === "amd64" ? "x64" : "arm64",
              ),
              "org.workbench.builder": offlineProfile(root, "offline").builder,
            },
          },
        });
      }
      return "";
    }),
  ),
}));
let temporary: string,
  root: string,
  profile: DevelopmentProfile & { offline: NonNullable<DevelopmentProfile["offline"]> };
beforeEach(() => {
  for (const name of ["CI", "GITHUB_ACTIONS", "GITLAB_CI"]) vi.stubEnv(name, "false");
  temporary = mkdtempSync(join(tmpdir(), "workbench-offline-test-"));
  root = join(temporary, "project");
  state.tools = join(temporary, "tools");
  state.calls = [];
  state.platform = process.arch === "arm64" ? "arm64" : "amd64";
  state.fail = "";
  state.image = `sha256:${"a".repeat(64)}`;
  state.policy = "fixture-policy";
  state.daemon = "";
  state.tree = undefined;
  state.binfmtUnavailable = false;
  state.guestMachine = undefined;
  state.target = "ghcr.io/example/offline:test";
  state.digest = `ghcr.io/example/offline@sha256:${"b".repeat(64)}`;
  state.onBuild = undefined;
  state.afterSnapshot = undefined;
  state.recipeEnvironment = undefined;
  state.config = { build: { dockerfile: "Dockerfile" }, workspaceFolder: "/workbench", remoteUser: "node" };
  for (const dir of ["workbench", "languages", "app", ".devcontainer"]) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(state.tools, "node_modules/@devcontainers/cli"), { recursive: true });
  writeFileSync(
    join(state.tools, "node_modules/@devcontainers/cli/package.json"),
    JSON.stringify({ version: "0.89.0", bin: { devcontainer: "cli.js" } }),
  );
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "languages/index.toml"), "");
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="go"\npath="app"\n',
  );
  profile = {
    name: "offline",
    builder: "native",
    workspace: "devcontainer",
    container_config: ".devcontainer/devcontainer.json",
    offline: { paths: ["app"], inputs: ["app/pin"], verify: ["node", "{workbench}/verify.mjs"] },
  };
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      development: { profiles: [profile] },
    }),
  );
  writeFileSync(join(root, ".devcontainer/devcontainer.json"), JSON.stringify(state.config));
  writeFileSync(join(root, "app/pin"), "1");
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(temporary, "cache"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(temporary, { recursive: true, force: true });
});

async function registryFixture({
  failure,
  label,
  repository = "ghcr.io/example/project-native",
}: { failure?: string; label?: string; repository?: string } = {}) {
  profile.offline.registry = repository;
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      development: { profiles: [profile] },
    }),
  );
  const { executeCI, CILifecycle } = await import("../scripts/ci-lifecycle.mjs");
  const original = vi.mocked(executeCI).getMockImplementation();
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(executeCI).mockImplementation(async (command: string, args: string[], options) => {
    if (command === "docker" && args[0] === "image" && args[1] === "inspect" && args.length === 3)
      throw new Error("No such image");
    if (command === "docker" && args[0] === "pull" && failure) {
      state.calls.push([command, ...args]);
      throw new Error(failure);
    }
    if (args.includes("{{json .Config.Labels}}"))
      return JSON.stringify({ "org.workbench.inputs": label ?? offlineInputs(root, profile) });
    return required(original, "Expected fixture value")(command, args, options);
  });
  return {
    CILifecycle,
    warning,
    restore() {
      vi.mocked(executeCI).mockImplementation(required(original, "Expected fixture value"));
      warning.mockRestore();
    },
  };
}

test("offline profiles validate their declared root, input paths, and command boundaries", () => {
  validateDevelopmentProfiles([profile], "profiles");
  expect(offlineProfile(root, "offline")).toEqual(profile);
  expect(() => offlineProfile(root, "missing")).toThrow(/not an offline/);
  for (const offline of [
    { ...profile.offline, inputs: [] },
    { ...profile.offline, inputs: ["../bad"] },
    { ...profile.offline, verify: ["\0"] },
    { ...profile.offline, unknown: true },
  ])
    expect(() => {
      validateDevelopmentProfiles([{ ...profile, offline }], "profiles");
    }).toThrow();
  expect(() => {
    validateDevelopmentProfiles([{ ...profile, workspace: "host", container_config: undefined }], "profiles");
  }).toThrow(/prepared images require/);
});

linuxTest("the shared offline verifier selects configured roots and custom verifiers remain explicit", async () => {
  const configPath = join(root, "workbench/config.toml");
  const config = configFromData(parse(readFileSync(configPath, "utf8")), undefined, "fixture");
  const development = required(config.development, "development configuration");
  const selected = required(development.profiles?.[0], "offline profile");
  delete required(selected.offline, "offline configuration").verify;
  writeFileSync(configPath, stringify(config));
  const resolved = offlineProfile(root, "offline");
  expect(resolved.offline.verify).toEqual([
    "node",
    "{workbench}/scripts/prepare-development.mjs",
    "native",
    "--verify",
    "--path",
    "app",
  ]);
  expect(offlineInputs(root, resolved)).toBe(offlineInputs(root, profile));
  await prepareOfflineProfile(root, "offline");
  const executed = state.calls.find(
    (call) => call[1] === "exec" && call.includes("/workbench/scripts/prepare-development.mjs"),
  );
  expect(executed).toContain("--verify");
  expect(executed?.slice(-2)).toEqual(["--path", "app"]);
  required(selected.offline, "offline configuration").verify = ["node", "custom-smoke.mjs"];
  writeFileSync(configPath, stringify(config));
  expect(offlineProfile(root, "offline").offline.verify).toEqual(["node", "custom-smoke.mjs"]);
});

linuxTest("workspace choice shares a prepared image identity and host profiles can prepare containers", async () => {
  const before = offlineInputs(root, profile);
  profile.workspace = "host";
  expect(offlineInputs(root, profile)).toBe(before);
  expect(() => {
    validateDevelopmentProfiles([profile], "profiles");
  }).not.toThrow();
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      development: { profiles: [profile] },
    }),
  );
  await prepareOfflineProfile(root, "offline");
  const receipt = preparedOfflineProfile(root, profile);
  expect(preparedOfflineProfile(root, { ...profile, workspace: "devcontainer" }).image).toBe(receipt.image);
});

linuxTest("image identities normalize executable permissions as a Git checkout does", () => {
  const pin = join(root, "app/pin");
  chmodSync(pin, 0o600);
  const plain = offlineInputs(root, profile);
  chmodSync(pin, 0o644);
  expect(offlineInputs(root, profile)).toBe(plain);
  chmodSync(pin, 0o700);
  const executable = offlineInputs(root, profile);
  expect(executable).not.toBe(plain);
  chmodSync(pin, 0o755);
  expect(offlineInputs(root, profile)).toBe(executable);
});

test("source and executable updates reuse dependency images while declared pins invalidate them", () => {
  const input = offlineInputs(root, profile);
  writeFileSync(join(root, "app/source.go"), "changed");
  expect(offlineInputs(root, profile)).toBe(input);
  writeFileSync(join(root, "app/pin"), "2");
  expect(offlineInputs(root, profile)).not.toBe(input);
  const changed = offlineInputs(root, profile);
  const config = join(root, "workbench/config.toml");
  const document = parse(readFileSync(config, "utf8"));
  document.tool = { repository: "https://forge.example/team/workbench.git", revision: "a".repeat(40) };
  writeFileSync(config, stringify(document));
  expect(offlineInputs(root, profile)).toBe(changed);
  const pinned = offlineInputs(root, profile);
  document.tool.revision = "b".repeat(40);
  writeFileSync(config, stringify(document));
  expect(offlineInputs(root, profile)).toBe(pinned);
  expect(offlineInputs(root, { ...profile, offline: { ...profile.offline, verify: ["different-check"] } })).toBe(
    pinned,
  );
  expect(offlineInputs(root, { ...profile, offline: { ...profile.offline, registry: "ghcr.io/example/new" } })).toBe(
    pinned,
  );
  expect(
    offlineInputs(root, { ...profile, offline: { ...profile.offline, prepare: ["different-orchestrator"] } }),
  ).not.toBe(pinned);
  const custom = { ...profile, offline: { ...profile.offline, prepare: ["prepare-one"] } };
  expect(offlineInputs(root, { ...custom, offline: { ...custom.offline, prepare: ["prepare-two"] } })).toBe(
    offlineInputs(root, custom),
  );
  expect(() => preparedOfflineProfile(root, profile)).toThrow(/not prepared/);
});

test("offline definitions reject lifecycle effects, hidden mounts, compose, and network overrides", () => {
  validateOfflineDefinition(state.config);
  for (const extra of [
    { postCreateCommand: "fetch" },
    { mounts: ["host-cache"] },
    { dockerComposeFile: "compose.yml" },
    { runArgs: ["--network=host"] },
    { workspaceFolder: "${localWorkspaceFolder}" },
    { remoteEnv: { PATH: "${containerEnv:PATH}" } },
    { containerEnv: { HOME: "${localEnv:HOME}" } },
  ])
    expect(() => {
      validateOfflineDefinition({ ...state.config, ...extra });
    }).toThrow();
});

linuxTest("preparation accepts only a fresh offline execution and records immutable image identity", async () => {
  const projectFiles = readdirSync(root, { recursive: true }).sort();
  state.config.containerUser = "node";
  state.config.containerEnv = { EXAMPLE: "offline" };
  await prepareOfflineProfile(root, "offline");
  const receipt = preparedOfflineProfile(root, profile);
  expect(receipt.image).toBe(state.image);
  const create = state.calls.find((call) => call[1] === "create");
  expect(create).toContain("--network=none");
  expect(create).toContain("EXAMPLE=offline");
  expect(
    required(create, "Expected fixture value: create")[
      required(create, "Expected fixture value: create").indexOf("--user") + 1
    ],
  ).toBe("node");
  expect(required(create, "Expected fixture value: create").filter((part) => part === "--mount")).toHaveLength(1);
  expect(
    required(create, "Expected fixture value: create").find(
      (part) => typeof part === "string" && part.startsWith("type=bind"),
    ),
  ).toMatch(/verification/);
  expect(state.calls.some((call) => call[1] === "exec" && call.includes("/workbench/verify.mjs"))).toBe(true);
  await verifyOfflineProfile(root, "offline");
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(projectFiles);
  writeFileSync(join(root, "app/pin"), "different");
  expect(() => preparedOfflineProfile(root, profile)).toThrow(/stale/);
});

linuxTest.each(["absent", "inherited", "overridden"] as const)(
  "verification forwards %s credentials without exposing them in process arguments",
  async (mode) => {
    vi.stubEnv("GH_TOKEN", mode === "absent" ? undefined : "credential-inherited");
    await prepareOfflineProfile(root, "offline");
    await executePreparedProfile(
      root,
      "offline",
      ["node", "/workbench/verify.mjs"],
      mode === "overridden" ? { env: { GH_TOKEN: "credential-override" } } : {},
    );
    const { executeCI } = await import("../scripts/ci-lifecycle.mjs");
    const invocation = required(
      [...vi.mocked(executeCI).mock.calls]
        .reverse()
        .find(([command, args]) => command === "docker" && args.includes("/workbench/verify.mjs")),
      "Expected offline verification",
    );
    expect(invocation[1].join(" ")).not.toContain("credential-");
    if (mode === "absent") expect(invocation[1]).not.toContain("GH_TOKEN");
    else expect(invocation[1]).toContain("GH_TOKEN");
    expect(invocation[2]?.env?.GH_TOKEN).toBe(
      mode === "absent" ? undefined : mode === "overridden" ? "credential-override" : "credential-inherited",
    );
    expect(process.env.GH_TOKEN).toBe(mode === "absent" ? undefined : "credential-inherited");
  },
);

linuxTest("failed verification preserves the previous receipt and removes the owned preparation image", async () => {
  await prepareOfflineProfile(root, "offline");
  const path = offlineReceiptPath(root, "offline");
  const before = readFileSync(path, "utf8");
  state.fail = "exec";
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/selected failure/);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(state.calls.some((call) => call[1] === "image" && call[2] === "rm")).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

linuxTest("missing host CLI gives the installation command and releases the preparation lock", async () => {
  rmSync(join(state.tools, "node_modules/@devcontainers/cli/package.json"));
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/tools install --devcontainer/);
  expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
  expect(state.calls).toHaveLength(0);
});

linuxTest("changing preparation inputs during a build cannot replace a previous accepted receipt", async () => {
  await prepareOfflineProfile(root, "offline");
  const path = offlineReceiptPath(root, "offline");
  const before = readFileSync(path, "utf8");
  state.onBuild = () => {
    writeFileSync(join(root, "app/pin"), "changed during build");
  };
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/inputs changed during preparation/);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

linuxTest("unknown profiles fail before creating preparation state or invoking Docker", async () => {
  for (const operation of [
    () => prepareOfflineProfile(root, "../outside"),
    () => verifyOfflineProfile(root, "../outside"),
    () => publishOfflineProfile(root, "../outside", state.target),
  ])
    await expect(operation()).rejects.toThrow(/not an offline development profile/);
  expect(state.calls).toEqual([]);
  expect(existsSync(join(temporary, "cache", "offline-profiles"))).toBe(false);
});

linuxTest("foreign image architectures are rejected before container execution", async () => {
  state.platform = "unsupported";
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/selected architecture/);
  expect(state.calls.some((call) => call[1] === "exec")).toBe(false);
});

linuxTest("publication is explicit, verifies a pulled registry digest, and cleans only its local tag", async () => {
  await expect(publishOfflineProfile(root, "offline", "example/test:tag")).rejects.toThrow(/explicit registry/);
  await prepareOfflineProfile(root, "offline");
  state.calls = [];
  await publishOfflineProfile(root, "offline", state.target);
  expect(state.calls).toContainEqual(["docker", "push", state.target]);
  const verification = state.calls.findIndex((call) => call[1] === "exec" && call.includes("/workbench/verify.mjs"));
  const publication = state.calls.findIndex((call) => call[1] === "push");
  expect(verification).toBeGreaterThanOrEqual(0);
  expect(verification).toBeLessThan(publication);
  expect(state.calls).toContainEqual(["docker", "pull", state.digest]);
  expect(preparedOfflineProfile(root, profile).published).toBe(state.digest);
  expect(state.calls.filter((call) => call[1] === "exec" && call.includes("/workbench/verify.mjs"))).toHaveLength(1);
  expect(state.calls).toContainEqual(["docker", "image", "rm", state.target]);
});

linuxTest(
  "failed offline verification prevents registry publication and preserves the preparation receipt",
  async () => {
    await prepareOfflineProfile(root, "offline");
    state.calls = [];
    state.fail = "exec";
    await expect(publishOfflineProfile(root, "offline", state.target)).rejects.toThrow(/selected failure/);
    expect(state.calls.some((call) => call[1] === "push" || call[1] === "tag")).toBe(false);
    expect(preparedOfflineProfile(root, profile).published).toBeUndefined();
    expect(preparedOfflineProfile(root, profile).image).toBe(state.image);
  },
);

test("hosted retention accepts explicit cache/download policy and rejects invalid values", () => {
  validateConfig({ schema_version: 1, ci: { cache: { artifacts: { llvm: "cache", rust: "download" } } } }, "config");
  expect(() => {
    validateConfig({ schema_version: 1, ci: { cache: { artifacts: { llvm: "off" } } } }, "config");
  }).toThrow();
});

linuxTest(
  "prebuilt pinned images can be prepared without building or installing their builder on the host",
  async () => {
    delete state.config.build;
    state.config.image = `ghcr.io/example/prepared@sha256:${"c".repeat(64)}`;
    await prepareOfflineProfile(root, "offline");
    expect(state.calls).toContainEqual([
      "docker",
      "pull",
      "--platform",
      `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
      state.config.image,
    ]);
    expect(state.calls.some((call) => call[0] === "build")).toBe(false);
    expect(preparedOfflineProfile(root, profile).image).toBe(state.image);
  },
);

linuxTest(
  "failed registry publication preserves the verified local image and records no published digest",
  async () => {
    await prepareOfflineProfile(root, "offline");
    state.fail = "push";
    await expect(publishOfflineProfile(root, "offline", state.target)).rejects.toThrow(/selected failure/);
    expect(preparedOfflineProfile(root, profile).published).toBeUndefined();
    expect(state.calls).toContainEqual(["docker", "image", "rm", state.target]);
  },
);

linuxTest("registry acquisition reuses the matching image and still verifies a fresh offline workspace", async () => {
  const registry = await registryFixture();
  try {
    await prepareOfflineProfile(root, "offline");
    expect(state.calls.some((call) => call[0] === "build")).toBe(false);
    expect(
      state.calls.some((call) => call[1] === "pull" && String(call.at(-1)).includes(offlineInputs(root, profile))),
    ).toBe(true);
    expect(state.calls.some((call) => call[1] === "create" && call.includes("--network=none"))).toBe(true);
    expect(preparedOfflineProfile(root, profile)).toMatchObject({
      inputs: offlineInputs(root, profile),
      image: state.image,
      platform: `linux-${process.arch}`,
    });
  } finally {
    registry.restore();
  }
});

linuxTest.each(["manifest unknown", "denied: authentication required", "network timeout"])(
  "registry retrieval failure (%s) builds locally and verifies the result offline",
  async (failure) => {
    const registry = await registryFixture({ failure });
    try {
      await prepareOfflineProfile(root, "offline");
      const pull = state.calls.findIndex((call) => call[0] === "docker" && call[1] === "pull");
      const builds = state.calls.filter((call) => call[0] === "build");
      expect(pull).toBeGreaterThanOrEqual(0);
      expect(builds).toHaveLength(1);
      expect(state.calls.indexOf(required(builds[0], "Expected fixture value"))).toBeGreaterThan(pull);
      const buildArguments = required(builds[0], "Expected fixture value: builds[0]")[2];
      if (!Array.isArray(buildArguments) || !buildArguments.every((value: unknown) => typeof value === "string"))
        throw new Error("Expected build arguments");
      expect(buildArguments).toContain("--config");
      expect(
        required(buildArguments[buildArguments.indexOf("--config") + 1], "Expected fixture value").endsWith(
          required(profile.container_config, "Expected fixture value"),
        ),
      ).toBe(true);
      expect(registry.warning.mock.calls.flat().join("\n")).toMatch(/building\s+offline\s+locally/);
      expect(state.calls.some((call) => call[1] === "create" && call.includes("--network=none"))).toBe(true);
      expect(preparedOfflineProfile(root, profile).image).toBe(state.image);
      expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
    } finally {
      registry.restore();
    }
  },
);

linuxTest("a failed fallback build preserves the accepted receipt and releases preparation ownership", async () => {
  const registry = await registryFixture({ failure: "network timeout" });
  try {
    await prepareOfflineProfile(root, "offline");
    const path = offlineReceiptPath(root, "offline");
    const accepted = readFileSync(path, "utf8");
    state.calls = [];
    state.onBuild = () => {
      throw new Error("local build failed");
    };
    await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/local build failed/);
    expect(readFileSync(path, "utf8")).toBe(accepted);
    expect(state.calls.some((call) => call[1] === "exec")).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    registry.restore();
  }
});

linuxTest.each(
  (["nix", "guix"] as const).flatMap((builder) =>
    ["manifest unknown", "denied: authentication required", "network timeout"].map(
      (failure) => [builder, failure] as const,
    ),
  ),
)("%s CI rejects unavailable registry images (%s) without building", async (builder, failure) => {
  profile.builder = builder;
  vi.stubEnv("CI", "true");
  const registry = await registryFixture({ failure });
  try {
    await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(
      /Required prepared image.*could not be pulled/,
    );
    expect(state.calls.some((call) => call[1] === "pull")).toBe(true);
    expect(
      state.calls.some((call) => call[0] === "build" || ["build", "create", "exec"].includes(String(call[1]))),
    ).toBe(false);
    expect(existsSync(offlineReceiptPath(root, "offline"))).toBe(false);
    expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
  } finally {
    registry.restore();
  }
});

linuxTest.each(["nix", "guix"] as const)("%s CI cannot bypass registry acquisition with --build", async (builder) => {
  profile.builder = builder;
  vi.stubEnv("GITHUB_ACTIONS", "true");
  const registry = await registryFixture();
  try {
    await expect(prepareOfflineProfile(root, "offline", { build: true })).rejects.toThrow(/cannot build locally/);
    expect(state.calls).toEqual([]);
  } finally {
    registry.restore();
  }
});

linuxTest("registry-only acquisition requires a configured registry", async () => {
  await expect(prepareOfflineProfile(root, "offline", { pullOnly: true })).rejects.toThrow(/requires offline.registry/);
  expect(state.calls).toEqual([]);
});

linuxTest("an explicit private registry can supply and receive a verified image", async () => {
  const repository = "registry.example.com:5000/team/development";
  state.target = `${repository}:test`;
  state.digest = `${repository}@sha256:${"b".repeat(64)}`;
  const registry = await registryFixture({ repository });
  try {
    await prepareOfflineProfile(root, "offline", { pullOnly: true });
    await publishOfflineProfile(root, "offline", state.target);
    expect(state.calls.some((call) => call[1] === "push" && call.at(-1) === state.target)).toBe(true);
    expect(state.calls.some((call) => call[1] === "pull" && call.at(-1) === state.digest)).toBe(true);
    expect(preparedOfflineProfile(root, profile).published).toBe(state.digest);
    expect(state.calls.some((call) => call[0] === "build")).toBe(false);
  } finally {
    registry.restore();
  }
});

linuxTest("interruption after failed retrieval does not admit a fallback build", async () => {
  const registry = await registryFixture({ failure: "network timeout" });
  const checkpoint = vi
    .spyOn(registry.CILifecycle.prototype, "checkpoint")
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("interrupted"));
  try {
    await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/interrupted/);
    expect(state.calls.some((call) => call[1] === "pull")).toBe(true);
    expect(state.calls.some((call) => call[0] === "build")).toBe(false);
    expect(registry.warning).not.toHaveBeenCalled();
    expect(existsSync(offlineReceiptPath(root, "offline"))).toBe(false);
    expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
  } finally {
    checkpoint.mockRestore();
    registry.restore();
  }
});

linuxTest("retrieved image identity failures stop preparation without a fallback build", async () => {
  const registry = await registryFixture({ label: "different inputs" });
  try {
    await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/input label does not match/);
    expect(state.calls.some((call) => call[0] === "build" || call[1] === "create")).toBe(false);
    expect(registry.warning).not.toHaveBeenCalled();
    expect(existsSync(offlineReceiptPath(root, "offline"))).toBe(false);
    expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
  } finally {
    registry.restore();
  }
});

linuxTest(
  "project preparation recipes replace the bootstrap build and receive literal image and distribution arguments",
  async () => {
    profile.builder = "guix";
    profile.offline.prepare = ["assemble-managed", "{workbench}/recipe.mjs", "{image}"];
    const config = configFromData(
      parse(readFileSync(join(root, "workbench/config.toml"), "utf8")),
      undefined,
      "fixture",
    );
    required(config.development, "Expected fixture value: config.development").profiles = [profile];
    writeFileSync(join(root, "workbench/config.toml"), stringify(config));
    await prepareOfflineProfile(root, "offline", { build: true });
    const recipe = state.calls.find((call) => call[0] === "assemble-managed");
    expect(required(recipe, "Expected fixture value: recipe")[1]).toMatch(/\/source\/recipe\.mjs$/);
    expect(required(recipe, "Expected fixture value: recipe")[2]).toMatch(/^workbench-offline:prepare-/);
    expect(state.recipeEnvironment).toMatchObject({
      WORKBENCH_PROJECT_ROOT: expect.stringMatching(/\/source$/) as unknown,
      WORKBENCH_LOCAL_CONFIG_ROOT: root,
      WORKBENCH_EPHEMERAL_CHECKOUT: "1",
    });
    expect(state.calls.some((call) => call[0] === "build")).toBe(false);
    expect(preparedOfflineProfile(root, profile).image).toBe(state.image);
  },
);

linuxTest("a failed managed recipe preserves the previous accepted receipt and never verifies its image", async () => {
  await prepareOfflineProfile(root, "offline", { build: true });
  const previous = readFileSync(offlineReceiptPath(root, "offline"), "utf8");
  profile.offline.prepare = ["assemble-managed", "fail-assembly"];
  const config = configFromData(parse(readFileSync(join(root, "workbench/config.toml"), "utf8")), undefined, "fixture");
  required(config.development, "Expected fixture value: config.development").profiles = [profile];
  writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  state.fail = "fail-assembly";
  state.calls = [];
  await expect(prepareOfflineProfile(root, "offline", { build: true })).rejects.toThrow(/selected failure/);
  expect(readFileSync(offlineReceiptPath(root, "offline"), "utf8")).toBe(previous);
  expect(state.calls.some((call) => call[0] === "docker" && call[1] === "create")).toBe(false);
});

linuxTest("profile image inspection checks the exact configured registry identity without preparation", async () => {
  profile.offline.registry = "ghcr.io/example/development";
  const config = configFromData(parse(readFileSync(join(root, "workbench/config.toml"), "utf8")), undefined, "fixture");
  required(config.development, "Expected fixture value: config.development").profiles = [profile];
  writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  const local = vi
    .spyOn(preparedImages, "inspectPreparedImages")
    .mockReturnValue({ location: "local", entries: [], issues: [] });
  const remote = vi.spyOn(preparedImages, "registryImageStatus").mockResolvedValue({ state: "available" });
  try {
    const rows = await inspectOfflineImages(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profile: "offline", local: "not prepared", registry: "available" });
    expect(required(rows[0], "Expected fixture value: rows[0]").reference).toBe(
      `ghcr.io/example/development:linux-${process.arch}-${offlineInputs(root, profile)}`,
    );
    expect(remote).toHaveBeenCalledWith(
      required(rows[0], "Expected fixture value: rows[0]").reference,
      expect.any(AbortSignal),
    );
    await expect(inspectOfflineImages(root, ["unknown"])).rejects.toThrow(/not an offline/);
    expect(state.calls).toEqual([]);
  } finally {
    local.mockRestore();
    remote.mockRestore();
  }
});

linuxTest(
  "ordinary prepared-image execution relies on Docker references without serializing jobs behind a profile writer lock",
  async () => {
    await prepareOfflineProfile(root, "offline");
    const { executeCI } = await import("../scripts/ci-lifecycle.mjs");
    const original = vi.mocked(executeCI).getMockImplementation();
    let executions = 0;
    vi.mocked(executeCI).mockImplementation(async (command, args: string[], options) => {
      if (args[0] === "exec" && args.includes("parallel-job")) {
        expect(existsSync(`${offlineReceiptPath(root, "offline")}.lock`)).toBe(false);
        executions++;
      }
      return required(original, "Expected fixture value")(command, args, options);
    });
    try {
      await Promise.all([
        executePreparedProfile(root, "offline", ["parallel-job"]),
        executePreparedProfile(root, "offline", ["parallel-job"]),
      ]);
      expect(executions).toBe(2);
    } finally {
      vi.mocked(executeCI).mockImplementation(required(original, "Expected fixture value"));
    }
  },
);

test("new subproject channels and root selection invalidate only the selected managed image", () => {
  const managed = { ...profile, builder: "guix" as const };
  writeFileSync(join(root, "channels.scm"), "root channel");
  const original = offlineInputs(root, managed);
  writeFileSync(join(root, "app/channels.scm"), "subproject channel");
  expect(offlineInputs(root, managed)).not.toBe(original);
  rmSync(join(root, "app/channels.scm"));
  expect(offlineInputs(root, managed)).toBe(original);
  mkdirSync(join(root, "another"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    readFileSync(join(root, "workbench/projects.toml"), "utf8") +
      '\n[[language_root]]\nlanguage="go"\npath="another"\n',
  );
  const all = { ...managed, offline: { ...managed.offline } };
  delete all.offline.paths;
  expect(offlineInputs(root, all)).not.toBe(original);
  expect(offlineInputs(root, managed)).toBe(original);
});

linuxTest("the preparation tag and label use the captured inputs through a transient checkout edit", async () => {
  const expected = offlineInputs(root, profile);
  const reference = offlineImageReference(root, "offline");
  let snapshots = 0;
  state.afterSnapshot = () => {
    if (++snapshots === 1) writeFileSync(join(root, "app/pin"), "temporary edit");
  };
  state.onBuild = () => {
    writeFileSync(join(root, "app/pin"), "1");
  };
  await prepareOfflineProfile(root, "offline");
  expect(preparedOfflineProfile(root, profile).inputs).toBe(expected);
  const metadata = state.calls.find((call) => call[0] === "finalize");
  expect(required(metadata, "Expected fixture value: metadata")[2]).toBe(reference);
});

linuxTest(
  "local verification reuse requires matching evidence; fresh, CI, source and environment changes execute again",
  async () => {
    state.daemon = "fixture-daemon";
    state.tree = "tree-a";
    // Count the verifier by its final argument: the mounted distribution path is resolved inside the container.
    const verifies = () =>
      state.calls.filter(
        (call) =>
          call[0] === "docker" &&
          call[1] === "exec" &&
          call.some((arg) => typeof arg === "string" && arg.endsWith("/verify.mjs")),
      ).length;
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(1);
    const accepted = preparedOfflineProfile(root, profile);
    expect(accepted).toHaveProperty("verification.key", expect.stringMatching(/^[a-f0-9]{64}$/));
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(1);
    expect(preparedOfflineProfile(root, profile).verified).toBe(accepted.verified);
    await prepareOfflineProfile(root, "offline", { fresh: true });
    expect(verifies()).toBe(2);
    vi.stubEnv("CI", "true");
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(3);
    vi.stubEnv("CI", "false");
    state.tree = "tree-b";
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(4);
    state.daemon = "other-daemon";
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(5);
  },
);

linuxTest(
  "preparation preserves verified publication for the same immutable image and drops it for another",
  async () => {
    await prepareOfflineProfile(root, "offline");
    const path = offlineReceiptPath(root, "offline");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...receipt, published: state.digest }));
    await prepareOfflineProfile(root, "offline", { fresh: true });
    expect(preparedOfflineProfile(root, profile).published).toBe(state.digest);
    state.image = `sha256:${"c".repeat(64)}`;
    await prepareOfflineProfile(root, "offline");
    expect(preparedOfflineProfile(root, profile).published).toBeUndefined();
  },
);

linuxTest(
  "publication retries reuse only recent identical offline evidence and explicit verification remains fresh",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    state.daemon = "fixture-daemon";
    state.tree = "tree-a";
    const verifies = () =>
      state.calls.filter(
        (call) =>
          call[0] === "docker" &&
          call[1] === "exec" &&
          call.some((arg) => typeof arg === "string" && arg.endsWith("/verify.mjs")),
      ).length;
    await prepareOfflineProfile(root, "offline");
    expect(verifies()).toBe(1);
    state.fail = "push";
    await expect(publishOfflineProfile(root, "offline", state.target)).rejects.toThrow("selected failure");
    expect(verifies()).toBe(1);
    state.fail = "";
    await publishOfflineProfile(root, "offline", state.target);
    expect(verifies()).toBe(1);
    await verifyOfflineProfile(root, "offline", state.image);
    expect(verifies()).toBe(2);
    expect(preparedOfflineProfile(root, profile).published).toBe(state.digest);
    expect(state.calls).toContainEqual(["docker", "tag", state.image, offlineImageReference(root, "offline")]);
    state.tree = "tree-b";
    await publishOfflineProfile(root, "offline", state.target);
    expect(verifies()).toBe(3);
    const path = offlineReceiptPath(root, "offline");
    writeFileSync(
      path,
      JSON.stringify({
        ...preparedOfflineProfile(root, profile),
        verified: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      }),
    );
    await publishOfflineProfile(root, "offline", state.target);
    expect(verifies()).toBe(4);
    state.daemon = "";
    await publishOfflineProfile(root, "offline", state.target);
    expect(verifies()).toBe(5);
  },
);

linuxTest("publication reuses equivalent bind-source references but detects changed environment meanings", async () => {
  state.daemon = "fixture-daemon";
  state.tree = "tree-a";
  const sources: string[] = [];
  state.afterSnapshot = (destination) => {
    sources.push(destination);
    state.config.containerEnv = { WORKBENCH_CONTAINER_CHECKOUT: destination };
    state.config.remoteEnv = { SOURCE_ROOT: destination, OTHER: "unchanged" };
  };
  const verifies = () =>
    state.calls.filter((call) => call[0] === "docker" && call[1] === "exec" && call.includes("/workbench/verify.mjs"))
      .length;
  await prepareOfflineProfile(root, "offline");
  await publishOfflineProfile(root, "offline", state.target);
  expect(new Set(sources).size).toBeGreaterThan(1);
  expect(verifies()).toBe(1);

  state.afterSnapshot = (destination) => {
    state.config.containerEnv = { WORKBENCH_CONTAINER_CHECKOUT: destination };
    state.config.remoteEnv = { SOURCE_ROOT: destination, OTHER: "changed" };
  };
  await publishOfflineProfile(root, "offline", state.target);
  expect(verifies()).toBe(2);

  // An earlier checkout's literal path is a different referent from the current bind source.
  state.afterSnapshot = (destination) => {
    state.config.containerEnv = { WORKBENCH_CONTAINER_CHECKOUT: required(sources[0], "Expected first source") };
    state.config.remoteEnv = { SOURCE_ROOT: destination, OTHER: "changed" };
  };
  await publishOfflineProfile(root, "offline", state.target);
  expect(verifies()).toBe(3);
});

linuxTest(
  "foreign assembly preserves the native accepted receipt and cannot create native verification evidence",
  async () => {
    await prepareOfflineProfile(root, "offline");
    const receipt = readFileSync(offlineReceiptPath(root, "offline"), "utf8");
    state.calls = [];
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    await prepareOfflineProfile(root, "offline", { build: true, architecture, assembleOnly: true });
    expect(readFileSync(offlineReceiptPath(root, "offline"), "utf8")).toBe(receipt);
    expect(state.calls.some((call) => call[1] === "exec")).toBe(false);
    const invocation = state.calls.find((call) => call[0] === "build");
    expect(invocation?.[2]).toContain(`linux/${architecture === "x64" ? "amd64" : "arm64"}`);
    expect(offlineImageReference(root, "offline", architecture)).not.toBe(offlineImageReference(root, "offline"));
  },
);

linuxTest(
  "assembly alone cannot activate an image; exact-image qualification accepts it only after successful execution",
  async () => {
    await prepareOfflineProfile(root, "offline", { assembleOnly: true });
    expect(existsSync(offlineReceiptPath(root, "offline"))).toBe(false);
    state.fail = "exec";
    await expect(verifyOfflineProfile(root, "offline", state.image)).rejects.toThrow("selected failure");
    expect(existsSync(offlineReceiptPath(root, "offline"))).toBe(false);
    state.fail = "";
    await verifyOfflineProfile(root, "offline", state.image);
    expect(preparedOfflineProfile(root, profile).image).toBe(state.image);
  },
);

linuxTest(
  "explicit foreign preparation verifies and publishes via binfmt without replacing the native receipt",
  async () => {
    state.daemon = "fixture-daemon";
    state.tree = "frozen-tree";
    await prepareOfflineProfile(root, "offline");
    const native = readFileSync(offlineReceiptPath(root, "offline"), "utf8");
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    state.platform = architecture === "x64" ? "amd64" : "arm64";
    state.image = `sha256:${"c".repeat(64)}`;
    state.calls = [];
    await prepareOfflineProfile(root, "offline", { architecture, build: true });
    expect(preparedOfflineProfile(root, profile, architecture)).toMatchObject({
      image: state.image,
      platform: `linux-${architecture}`,
      verificationHost: `linux-${process.arch}`,
      verificationMethod: "binfmt",
    });
    const create = state.calls.find((call) => call[1] === "create");
    expect(create).toContain("--network=none");
    expect(create).toContain(`linux/${state.platform}`);
    await publishOfflineProfile(root, "offline", state.target, architecture);
    expect(state.calls).toContainEqual(["docker", "pull", "--platform", `linux/${state.platform}`, state.digest]);
    expect(preparedOfflineProfile(root, profile, architecture).published).toBe(state.digest);
    expect(readFileSync(offlineReceiptPath(root, "offline"), "utf8")).toBe(native);
    const foreign = readFileSync(offlineReceiptPath(root, "offline", architecture), "utf8");
    state.binfmtUnavailable = true;
    state.calls = [];
    await expect(publishOfflineProfile(root, "offline", state.target, architecture)).rejects.toThrow(/binfmt_misc/);
    expect(state.calls.some((call) => call[1] === "push")).toBe(false);
    expect(readFileSync(offlineReceiptPath(root, "offline", architecture), "utf8")).toBe(foreign);
    expect(readFileSync(offlineReceiptPath(root, "offline"), "utf8")).toBe(native);
  },
);

linuxTest(
  "foreign preparation refuses a missing persistent emulator before acquiring or accepting an image",
  async () => {
    state.binfmtUnavailable = true;
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    await expect(prepareOfflineProfile(root, "offline", { architecture })).rejects.toThrow(
      /persistent F-flag emulator/,
    );
    expect(state.calls).toEqual([]);
    expect(existsSync(offlineReceiptPath(root, "offline", architecture))).toBe(false);
  },
);

linuxTest("foreign labels cannot substitute for execution of the selected architecture", async () => {
  const architecture = process.arch === "arm64" ? "x64" : "arm64";
  state.platform = architecture === "x64" ? "amd64" : "arm64";
  state.guestMachine = process.arch === "x64" ? "x86_64" : "aarch64";
  await expect(prepareOfflineProfile(root, "offline", { architecture })).rejects.toThrow(/Container execution reports/);
  expect(existsSync(offlineReceiptPath(root, "offline", architecture))).toBe(false);
  expect(state.calls.some((call) => call.at(-1) === "/workbench/verify.mjs")).toBe(false);
});

linuxTest(
  "prepared execution mounts an external Workbench runtime read-only without modifying the project",
  async () => {
    await prepareOfflineProfile(root, "offline");
    const before = readdirSync(root, { recursive: true }).sort();
    const distribution = join(temporary, "external runtime");
    mkdirSync(distribution);
    cpSync(join(root, "languages"), join(distribution, "languages"), { recursive: true });
    writeFileSync(join(distribution, "verify.mjs"), "// external runtime fixture\n");
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    await executePreparedProfile(root, "offline", ["node", "{workbench}/verify.mjs"]);
    const create = state.calls.filter((call) => call[1] === "create").at(-1);
    expect(create).toContain(`type=bind,src=${distribution},dst=/opt/workbench-runtime,readonly`);
    expect(state.calls.some((call) => call[1] === "exec" && call.includes("/opt/workbench-runtime/verify.mjs"))).toBe(
      true,
    );
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(join(distribution, "verify.mjs"), "utf8")).toBe("// external runtime fixture\n");
  },
);

linuxTest("architecture operations overlap while another operation on the same architecture waits", async () => {
  const firstGate = Promise.withResolvers<undefined>();
  const foreignGate = Promise.withResolvers<undefined>();
  let firstEntered = false,
    foreignEntered = false,
    sameEntered = false;
  const first = withOfflineProfileLock(root, "offline", "x64", async () => {
    firstEntered = true;
    await firstGate.promise;
  });
  let foreign: Promise<void> | undefined, same: Promise<void> | undefined;
  try {
    await vi.waitFor(
      () => {
        expect(firstEntered).toBe(true);
      },
      { timeout: 10000 },
    );
    same = withOfflineProfileLock(root, "offline", "x64", () => {
      sameEntered = true;
      return Promise.resolve();
    });
    foreign = withOfflineProfileLock(root, "offline", "arm64", async () => {
      foreignEntered = true;
      await foreignGate.promise;
    });
    await vi.waitFor(
      () => {
        expect(foreignEntered).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(sameEntered).toBe(false);
  } finally {
    firstGate.resolve(undefined);
    foreignGate.resolve(undefined);
    await Promise.all([first, foreign, same]);
  }
  expect(sameEntered).toBe(true);
});
