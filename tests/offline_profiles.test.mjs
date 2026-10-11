import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  offlineProfile,
  offlineInputs,
  offlineReceiptPath,
  preparedOfflineProfile,
  validateOfflineDefinition,
  prepareOfflineProfile,
  verifyOfflineProfile,
  publishOfflineProfile,
} from "../src/offline-profiles.ts";
import { validateDevelopmentProfiles } from "../src/profile-schema.ts";
import { validateConfig } from "../src/config-schema.ts";

const linuxTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));

const state = vi.hoisted(() => ({
  tools: "",
  calls: [],
  platform: "amd64",
  fail: "",
  config: {},
  onBuild: undefined,
  image: `sha256:${"a".repeat(64)}`,
  target: "ghcr.io/example/offline:test",
  digest: `ghcr.io/example/offline@sha256:${"b".repeat(64)}`,
}));
vi.mock("../src/native-tools.js", () => ({
  containerToolsDirectory: () => state.tools,
  nativeEnvironment: () => process.env,
}));
vi.mock("../src/devcontainers.js", () => ({
  validateContainerOwnership: vi.fn(),
  containerStartup: vi.fn(async (...args) => {
    state.calls.push(["build", ...args]);
    state.onBuild?.();
    return "{}";
  }),
}));
vi.mock("../src/ci-workspace.js", () => ({
  snapshotCIProject: vi.fn(async (root, destination) => {
    cpSync(root, destination, { recursive: true });
    return [];
  }),
}));
vi.mock("../src/ci-lifecycle.js", () => ({
  CILifecycle: class {
    checkpoint() {
      return Promise.resolve();
    }
    close() {}
  },
  executeCI: vi.fn(async (command, args) => {
    state.calls.push([command, ...args]);
    if (state.fail && args.includes(state.fail)) throw new Error("selected failure");
    if (command === "node") return JSON.stringify({ configuration: state.config });
    if (args[0] === "image" && args[1] === "inspect") {
      if (args[2] === state.target) throw new Error("No such image");
      if (args.includes("{{json .RepoDigests}}")) return JSON.stringify([state.digest]);
      if (args.includes("{{.Id}}")) return state.image;
      return JSON.stringify({ Os: "linux", Architecture: state.platform, Config: {} });
    }
    return "";
  }),
}));
let temporary, root, profile;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "workbench-offline-test-"));
  root = join(temporary, "project");
  state.tools = join(temporary, "tools");
  state.calls = [];
  state.platform = process.arch === "arm64" ? "arm64" : "amd64";
  state.fail = "";
  state.onBuild = undefined;
  state.config = { build: { dockerfile: "Dockerfile" }, workspaceFolder: "/workbench", remoteUser: "node" };
  for (const dir of ["workbench", "languages", "app", ".devcontainer"]) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(state.tools, "node_modules/@devcontainers/cli"), { recursive: true });
  writeFileSync(
    join(state.tools, "node_modules/@devcontainers/cli/package.json"),
    JSON.stringify({ version: "0.89.0", bin: { devcontainer: "cli.js" } }),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@devcontainers/cli": "0.89.0" } }));
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
    offline: { path: "app", inputs: ["app/pin"], verify: ["node", "{workbench}/verify.mjs"] },
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
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(temporary, { recursive: true, force: true });
});

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
    expect(() => validateDevelopmentProfiles([{ ...profile, offline }], "profiles")).toThrow();
  expect(() =>
    validateDevelopmentProfiles([{ ...profile, workspace: "host", container_config: undefined }], "profiles"),
  ).toThrow(/offline requires/);
});

test("source changes reuse prepared inputs while pins, recipes, and profile changes invalidate them", () => {
  const input = offlineInputs(root, profile);
  writeFileSync(join(root, "app/source.go"), "changed");
  expect(offlineInputs(root, profile)).toBe(input);
  writeFileSync(join(root, "app/pin"), "2");
  expect(offlineInputs(root, profile)).not.toBe(input);
  const changed = offlineInputs(root, profile);
  writeFileSync(
    join(root, "workbench/distribution.json"),
    JSON.stringify({ schema_version: 1, revision: "a".repeat(40), sha256: "b".repeat(64) }),
  );
  expect(offlineInputs(root, profile)).not.toBe(changed);
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
    expect(() => validateOfflineDefinition({ ...state.config, ...extra })).toThrow();
});

linuxTest("preparation accepts only a fresh offline execution and records immutable image identity", async () => {
  state.config.containerUser = "node";
  state.config.containerEnv = { EXAMPLE: "offline" };
  await prepareOfflineProfile(root, "offline");
  const receipt = preparedOfflineProfile(root, profile);
  expect(receipt.image).toBe(state.image);
  const create = state.calls.find((call) => call[1] === "create");
  expect(create).toContain("--network=none");
  expect(create).toContain("EXAMPLE=offline");
  expect(create[create.indexOf("--user") + 1]).toBe("node");
  expect(create.filter((part) => part === "--mount")).toHaveLength(1);
  expect(create.find((part) => typeof part === "string" && part.startsWith("type=bind"))).toMatch(/verification/);
  expect(state.calls.some((call) => call[1] === "exec" && call.includes("/workbench/verify.mjs"))).toBe(true);
  await verifyOfflineProfile(root, "offline");
  writeFileSync(join(root, "app/pin"), "different");
  expect(() => preparedOfflineProfile(root, profile)).toThrow(/stale/);
});

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
  state.onBuild = () => writeFileSync(join(root, "app/pin"), "changed during build");
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/inputs changed during preparation/);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

linuxTest("foreign image architectures are rejected before container execution", async () => {
  state.platform = "unsupported";
  await expect(prepareOfflineProfile(root, "offline")).rejects.toThrow(/native architecture/);
  expect(state.calls.some((call) => call[1] === "exec")).toBe(false);
});

linuxTest("publication is explicit, verifies a pulled registry digest, and cleans only its local tag", async () => {
  await expect(publishOfflineProfile(root, "offline", "docker.io/example/test:tag")).rejects.toThrow(/ghcr/);
  await prepareOfflineProfile(root, "offline");
  state.calls = [];
  await publishOfflineProfile(root, "offline", state.target);
  expect(state.calls).toContainEqual(["docker", "push", state.target]);
  expect(state.calls).toContainEqual(["docker", "pull", state.digest]);
  expect(preparedOfflineProfile(root, profile).published).toBe(state.digest);
  expect(state.calls.filter((call) => call[1] === "exec")).toHaveLength(2);
  expect(state.calls).toContainEqual(["docker", "image", "rm", state.target]);
});

test("hosted retention accepts explicit cache/download policy and rejects invalid values", () => {
  validateConfig({ schema_version: 1, ci: { cache: { artifacts: { llvm: "cache", rust: "download" } } } }, "config");
  expect(() =>
    validateConfig({ schema_version: 1, ci: { cache: { artifacts: { llvm: "off" } } } }, "config"),
  ).toThrow();
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
