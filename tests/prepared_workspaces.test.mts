import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { executeDevcontainer } from "../src/devcontainers.ts";
import { prepareOfflineProfile } from "../src/offline-profiles.ts";

const state = vi.hoisted(
  (): {
    root: string;
    cli: string;
    profile: object;
    ready: boolean;
    missing: boolean;
    invocation: string[];
    override: { image?: string; runArgs?: string[] };
  } => ({
    root: "",
    cli: "",
    profile: {},
    ready: false,
    missing: false,
    invocation: [] as string[],
    override: {},
  }),
);
const image = `sha256:${"a".repeat(64)}`;
vi.mock("../src/native-tools.js", () => ({ nativeEnvironment: () => process.env }));
vi.mock("../src/container-tools.js", () => ({ containerCLI: () => state.cli }));
vi.mock("../src/environments.js", () => ({ selectedDevelopmentProfile: () => state.profile }));
vi.mock("../src/builds.js", () => ({ buildPaths: () => ({ external: true, identity: { checkout: state.root } }) }));
vi.mock("../src/policy-compatibility.js", () => ({ policyExecutionEnvironment: () => ({}) }));
vi.mock("../src/execution-resources.js", () => ({ executionEnvironment: () => ({ WORKBENCH_CPU_BUDGET: "2" }) }));
vi.mock("../src/offline-profiles.js", async (original) => ({
  ...(await original<typeof import("../src/offline-profiles.js")>()),
  preparedOfflineProfile: () => {
    if (!state.ready) throw new Error("not prepared");
    return { image: `sha256:${"a".repeat(64)}` };
  },
  prepareOfflineProfile: vi.fn<typeof import("../src/offline-profiles.js").prepareOfflineProfile>(() =>
    promised(() => {
      state.ready = true;
      state.missing = false;
    }),
  ),
}));
vi.mock("../src/tool-downloads.js", () => ({
  execute: (command: string, args: string[]) => {
    if (command === "docker") {
      if (args[0] === "image" && state.missing) throw new Error("No such image");
      if (args.includes("{{json .Mounts}}"))
        return JSON.stringify([{ Source: state.root, Destination: "/workbench", RW: true }]);
      if (args.includes("{{json .}}"))
        return JSON.stringify({ Image: `sha256:${"a".repeat(64)}`, HostConfig: { NetworkMode: "bridge" } });
      return "";
    }
    if (args[1] === "read-configuration")
      return JSON.stringify({ configuration: { build: { dockerfile: "Dockerfile" }, workspaceFolder: "/workbench" } });
    if (args[1] === "exec") {
      state.invocation = args;
      state.override = JSON.parse(
        readFileSync(required(args[args.indexOf("--override-config") + 1], "Expected fixture value"), "utf8"),
      ) as typeof state.override;
    }
    return "";
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

test
  .skipIf(process.platform === "win32")
  .each(
    ["native", "nix", "guix"].flatMap((builder) =>
      ["retained", "unprepared", "deleted-image"].map((condition) => [builder, condition]),
    ),
  )(
  "%s workspace acquires prepared tools when %s and retains normal development networking",
  async (builder, condition) => {
    state.root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-prepared-workspace-")));
    for (const directory of ["languages", ".devcontainer"]) mkdirSync(join(state.root, directory));
    writeFileSync(join(state.root, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
    writeFileSync(join(state.root, ".devcontainer/devcontainer.json"), "{}");
    state.cli = join(state.root, "cli.cjs");
    writeFileSync(
      state.cli,
      'process.stdout.write(JSON.stringify({outcome:"success",containerId:"fixture",remoteWorkspaceFolder:"/workbench"}));',
    );
    state.profile = {
      name: builder,
      builder,
      workspace: "devcontainer",
      container_config: ".devcontainer/devcontainer.json",
      offline: { paths: ["."] },
    };
    state.ready = condition !== "unprepared";
    state.missing = condition === "deleted-image";
    state.invocation = [];
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", state.root);
    await executeDevcontainer(state.root, state.root, ["echo", "literal $HOME"]);
    expect(prepareOfflineProfile).toHaveBeenCalledTimes(condition === "retained" ? 0 : 1);
    expect(state.override.image).toBe(image);
    expect(state.override.runArgs ?? []).not.toContain("--network=none");
    const remote: unknown = Object.fromEntries(
      state.invocation.flatMap((arg, index) =>
        arg === "--remote-env"
          ? [
              required(state.invocation[index + 1], "Expected fixture value: state.invocation[index + 1]")
                .split(/=(.*)/s)
                .slice(0, 2),
            ]
          : [],
      ),
    );
    expect((remote as Record<string, string>).WORKBENCH_WORKSPACE_CONTEXT).toBe("devcontainer");
    expect(remote).not.toHaveProperty("WORKBENCH_OFFLINE");
    expect(state.invocation).toContain(builder === "native" ? "native-exec" : "managed-exec");
    expect(state.invocation.slice(-2)).toEqual(["echo", "literal $HOME"]);
  },
);
