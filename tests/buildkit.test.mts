import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test as baseTest, vi } from "vitest";
import { withProjectBuilder, inspectBuildkitCache, buildProjectImage } from "../src/buildkit.ts";
import { pruneBuilderCache } from "../src/builder-cache.ts";

const test = baseTest.skipIf(process.platform === "win32");
const state = vi.hoisted(() => ({
  volumes: [] as { Name: string; CreatedAt: string; Labels: Record<string, string> }[],
  containers: [] as {
    Id: string;
    Created: string;
    Config: { Image: string; Env: string[] };
    Mounts: { Name: string; Destination: string }[];
  }[],
  calls: [] as {
    command: string;
    args: string[];
    options: Parameters<typeof import("../src/ci-lifecycle.ts").executeCI>[2];
  }[],
  image: "",
  token: "",
  name: "",
  engine: "engine-one",
  fail: false,
  failRemove: false,
}));
vi.mock("../src/ci-lifecycle.js", () => ({
  executeCI: vi.fn<typeof import("../src/ci-lifecycle.js").executeCI>((command, args, options) => {
    return promised(() => {
      state.calls.push({ command, args, options });
      if (args[0] === "buildx" && args[1] === "create") {
        state.name = required(args[args.indexOf("--node") + 1], "Builder node name");
        state.image = required(
          args.find((arg: string) => arg.startsWith("image=")),
          'Expected fixture value: args.find((arg: string) => arg.startsWith("image="))',
        ).slice(6);
        state.token = required(
          args.find((arg: string) => arg.startsWith("env.WORKBENCH_BUILDER_TOKEN=")),
          'Expected fixture value: args.find((arg: string) => arg.startsWith("env.WORKBENCH_BUILDER_TOKEN="))',
        ).slice(4);
      }
      if (args[0] === "buildx" && args[1] === "inspect") {
        state.containers = [
          {
            Id: "c".repeat(64),
            Created: "created-container",
            Config: { Image: state.image, Env: [state.token] },
            Mounts: [{ Name: `buildx_buildkit_${state.name}_state`, Destination: "/var/lib/buildkit" }],
          },
        ];
        if (state.fail) throw new Error("bootstrap failed");
      }
      if (args[0] === "container" && args[1] === "rm") state.containers = [];
      if (args[0] === "volume" && args[1] === "rm") {
        if (state.failRemove) throw new Error("volume deletion failed");
        state.volumes = [];
      }
      return "";
    });
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn((command: string, args: string[]) => {
    let result;
    if (command === "sh") result = "/usr/bin/docker";
    else if (args[0] === "info") result = state.engine;
    else if (args[0] === "system") result = state.volumes.map(({ Name }) => ({ Name, Size: "1.5GB" }));
    else if (args[0] === "ps")
      result = args.includes("--no-trunc")
        ? state.containers.map(({ Id }) => Id).join("\n")
        : (state.containers[0]?.Id ?? "");
    else if (args[0] === "volume" && args[1] === "create") {
      state.volumes = [
        {
          Name: required(args.at(-1), "Volume name"),
          CreatedAt: "created-volume",
          Labels: Object.fromEntries(
            args
              .filter((arg: string) => arg.startsWith("org.workbench."))
              .map((arg: string) => {
                const separator = arg.indexOf("=");
                return [arg.slice(0, separator), arg.slice(separator + 1)] as const;
              }),
          ),
        },
      ];
      result = args.at(-1);
    } else if (args[0] === "volume" && args[1] === "ls") result = state.volumes.map(({ Name }) => Name).join("\n");
    else if (args[0] === "volume" && args[1] === "inspect") result = state.volumes;
    else if (args[0] === "container" && args[1] === "inspect") result = state.containers;
    else throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
    return { status: 0, stdout: typeof result === "string" ? result : JSON.stringify(result), stderr: "" };
  }),
}));
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  state.volumes = [];
  state.containers = [];
  state.calls = [];
  state.engine = "engine-one";
  state.fail = false;
  state.failRemove = false;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-buildkit-test-"));
  temporary.push(root);
  writeFileSync(join(root, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("PATH", root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", process.cwd());
  vi.stubEnv("WORKBENCH_CONTAINER_CHECKOUT", root);
  return root;
}

test("project builds reuse an owned volume and leave the default builder unchanged", async () => {
  const root = fixture();
  let wrapper = "";
  await withProjectBuilder(root, async (client) => {
    wrapper = client.docker;
    expect(readFileSync(wrapper, "utf8")).toContain(`--builder '${client.name}' --load`);
    expect(client.env.BUILDX_CONFIG).toBeDefined();
    expect(
      required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
        .blockedBy,
    ).toMatch(/lock/);
    await expect(pruneBuilderCache(inspectBuildkitCache(root))).rejects.toThrow(/not removable/);
  });
  expect(existsSync(wrapper)).toBe(false);
  const first = inspectBuildkitCache(root).entries[0];
  expect(required(first, "Expected fixture value: first").bytes).toBe(1500000000);
  expect(required(first, "Expected fixture value: first").blockedBy).toBeUndefined();
  await buildProjectImage(root, ["--tag", "example:test", "/context"]);
  expect(
    required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
      .identity,
  ).toBe(required(first, "Expected fixture value: first").identity);
  expect(state.calls.filter(({ args }) => args.includes("create"))).toHaveLength(2);
  expect(state.calls.some(({ args }) => args.includes("--use"))).toBe(false);
  const build = state.calls.find(({ args }) => args[0] === "build");
  expect(required(build, "Expected fixture value: build").args).toEqual(["build", "--tag", "example:test", "/context"]);
  await pruneBuilderCache(inspectBuildkitCache(root));
  expect(state.containers).toEqual([]);
  expect(state.volumes).toEqual([]);
  expect(inspectBuildkitCache(root).entries).toEqual([]);
});

test.each(["volume", "container", "engine"])("replaced %s identity blocks use and cleanup", async (kind) => {
  const root = fixture();
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  const selected = inspectBuildkitCache(root);
  if (kind === "volume")
    required(state.volumes[0], "Expected fixture value: state.volumes[0]").CreatedAt = "replacement";
  if (kind === "container")
    required(state.containers[0], "Expected fixture value: state.containers[0]").Id = "d".repeat(64);
  if (kind === "engine") state.engine = "engine-two";
  await expect(pruneBuilderCache(selected)).rejects.toThrow();
  expect(state.calls.some(({ args }) => args[1] === "rm")).toBe(false);
  if (kind !== "engine")
    await expect(
      withProjectBuilder(root, () => {
        return promised(() => undefined);
      }),
    ).rejects.toThrow(/ownership receipt/);
});

test("failed bootstrap records its owned partial installation and can recover", async () => {
  const root = fixture();
  state.fail = true;
  await expect(
    withProjectBuilder(root, () => {
      return promised(() => undefined);
    }),
  ).rejects.toThrow(/bootstrap failed/);
  expect(
    required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
      .blockedBy,
  ).toBeUndefined();
  state.fail = false;
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  state.containers = []; // docker system prune may remove the daemon, preserving its labeled volume.
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  expect(
    required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
      .blockedBy,
  ).toBeUndefined();
});

test("an unowned volume is never adopted by name", async () => {
  const root = fixture();
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  const receipt = required(
    inspectBuildkitCache(root).entries[0],
    "Expected fixture value: inspectBuildkitCache(root).entries[0]",
  ).receipt;
  rmSync(required(receipt, "Fixture value receipt"));
  state.containers = [];
  await expect(
    withProjectBuilder(root, () => {
      return promised(() => undefined);
    }),
  ).rejects.toThrow(/ownership receipt/);
  expect(state.volumes).toHaveLength(1);
});

test("foreign attachments and malformed ownership receipts stay protected", async () => {
  const root = fixture();
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  const entry = inspectBuildkitCache(root).entries[0];
  state.containers.push({ ...required(state.containers[0], "Owned container"), Id: "foreign" });
  expect(
    required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
      .blockedBy,
  ).toMatch(/another Docker container/);
  writeFileSync(
    required(
      required(entry, "Expected fixture value: entry").receipt,
      'Fixture value required(entry, "Expected fixture value: entry").receipt',
    ),
    JSON.stringify({ checkout: root }),
  );
  expect(inspectBuildkitCache(root).issues[0]).toMatch(/invalid BuildKit ownership/);
});

test("discovery without receipts neither probes Docker nor starts a builder", () => {
  const root = fixture();
  mkdirSync(join(root, "cache"), { recursive: true });
  expect(inspectBuildkitCache(root)).toEqual({ entries: [], issues: [] });
  expect(state.calls).toEqual([]);
});

test("partial cleanup retains ownership so the remaining volume can be pruned later", async () => {
  const root = fixture();
  await withProjectBuilder(root, () => {
    return promised(() => undefined);
  });
  state.failRemove = true;
  await expect(pruneBuilderCache(inspectBuildkitCache(root))).rejects.toThrow(/volume deletion failed/);
  const remaining = inspectBuildkitCache(root).entries[0];
  expect(
    existsSync(
      required(
        required(remaining, "Expected fixture value: remaining").receipt,
        'Fixture value required(remaining, "Expected fixture value: remaining").receipt',
      ),
    ),
  ).toBe(true);
  expect(required(remaining, "Expected fixture value: remaining").blockedBy).toBeUndefined();
  expect(state.containers).toEqual([]);
  state.failRemove = false;
  await pruneBuilderCache(inspectBuildkitCache(root));
  expect(state.volumes).toEqual([]);
});

test("failed builds release their lock and private client configuration", async () => {
  const root = fixture();
  let client: Parameters<Parameters<typeof withProjectBuilder>[1]>[0] | undefined;
  await expect(
    withProjectBuilder(root, (value) => {
      return promised(() => {
        client = value;
        throw new Error("build failed");
      });
    }),
  ).rejects.toThrow(/build failed/);
  expect(existsSync(required(client, "Expected fixture value: client").docker)).toBe(false);
  expect(
    required(inspectBuildkitCache(root).entries[0], "Expected fixture value: inspectBuildkitCache(root).entries[0]")
      .blockedBy,
  ).toBeUndefined();
});
