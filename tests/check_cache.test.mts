import { promised } from "./fixtures/promised.mjs";
import type { planChecks } from "../src/check-plan.ts";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withCachedChecks } from "../src/check-cache.ts";
import { inspectBuildCache, pruneBuildCache } from "../src/build-cache.ts";
import { buildPaths } from "../src/builds.ts";
import { checkCacheFixtures } from "./fixtures/check-cache.mjs";
import { checkExecution } from "../src/check-resources.ts";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  availableParallelism: () => 8,
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[] = [], options?: SpawnSyncOptionsWithStringEncoding) =>
      command === process.execPath && args.length === 1 && args[0] === "--version"
        ? { status: 0, stdout: `${process.version}\n`, stderr: "" }
        : actual.spawnSync(command, args, options),
    ),
  };
});

const fixture = checkCacheFixtures();

test("security refresh recomputes only selected ordering and leaves the full evidence plan unchanged", async () => {
  const f = fixture();
  const group = required(f.plan.sessions[0], "root session");
  const check = required(group.checks[0], "root check");
  group.checks.unshift({ ...check, name: "setup", role: "setup" });
  group.checks.push({ ...check, name: "secret", role: "secret", requiresSetup: false });
  const child = join(f.root, "child");
  mkdirSync(child);
  f.plan.sessions.push({ ...group, directory: child, checks: [{ ...check, directory: child }] });
  f.plan.automatic = true;
  f.plan.ordering = [{ root: "child", after: ".", phase: "setup" }];
  const before = structuredClone(f.plan);
  const runs: { roles: string[]; dependencies: ReturnType<typeof checkExecution>["dependencies"] }[] = [];
  const run = (plan: ReturnType<typeof planChecks>) =>
    promised(() => {
      runs.push({
        roles: plan.sessions.flatMap((session) => session.checks.map((check) => check.role)),
        dependencies: checkExecution(f.root, plan).dependencies,
      });
    });
  await f.run({}, run);
  await f.run({}, run);
  expect(runs).toEqual([
    { roles: ["setup", "test", "secret", "test"], dependencies: [[], [{ session: 0, phase: "setup" }]] },
    { roles: ["secret"], dependencies: [[]] },
  ]);
  expect(f.plan).toEqual(before);
});

test("successful complete gates are reused; explicit fresh runs replace evidence and CI/roles remain fresh", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  expect(f.executions()).toBe(1);
  await f.run({ cache: false });
  await f.run();
  expect(f.executions()).toBe(2);
  await f.run({ stage: "ci" });
  await f.run({ role: ["test"] });
  vi.stubEnv("CI", "true");
  await f.run();
  expect(f.executions()).toBe(5);
});

test("failed forced reruns invalidate earlier success; corrupt results also run fresh", async () => {
  const f = fixture();
  await f.run();
  await expect(
    f.run({ cache: false }, () => {
      return promised(() => {
        throw new Error("suite failed");
      });
    }),
  ).rejects.toThrow("suite failed");
  await f.run();
  expect(f.executions()).toBe(2);
  const entry = inspectBuildCache(f.root).entries.find(({ kind }) => kind === "checks");
  writeFileSync(join(required(entry, "Expected fixture value: entry").directory, "result.json"), "corrupt JSON");
  await f.run();
  expect(f.executions()).toBe(3);
  await pruneBuildCache(inspectBuildCache(f.root), false, true);
  expect(existsSync(required(entry, "Expected fixture value: entry").directory)).toBe(false);
  await f.run();
  expect(f.executions()).toBe(4);
});

test("inputs changed during a successful run do not acquire success evidence", async () => {
  const f = fixture();
  const messages = vi.spyOn(console, "log");
  await f.run({}, () => {
    return promised(() => {
      writeFileSync(join(f.root, "source.txt"), "edited during gate");
    });
  });
  expect(messages.mock.calls.flat().join("\n")).toContain("inputs changed during execution (source)");
  expect(inspectBuildCache(f.root).entries.filter(({ kind }) => kind === "checks")).toHaveLength(0);
  await f.run();
  await f.run();
  expect(f.executions()).toBe(1);
});

test("cancellation before result publication cannot save or retain successful evidence", async () => {
  const f = fixture();
  await f.run();
  const cancellation = new AbortController();
  await expect(
    withCachedChecks(
      f.root,
      { cache: false },
      f.plan,
      async () => {
        await f.action();
        setImmediate(() => {
          cancellation.abort();
        });
      },
      cancellation.signal,
    ),
  ).rejects.toThrow("aborted");
  await f.run();
  expect(f.executions()).toBe(3);
});

test("coverage generated during a successful gate does not prevent saving its evidence", async () => {
  const f = fixture();
  await f.run({}, async () => {
    await f.action();
    mkdirSync(join(f.root, "coverage"));
    writeFileSync(join(f.root, "coverage/coverage-summary.json"), "{}");
  });
  await f.run();
  expect(f.executions()).toBe(1);
});

test("independent security checks refresh without setup required only by cached tests", async () => {
  const f = fixture();
  const group = f.plan.sessions[0];
  required(group, "Expected fixture value: group").checks.push(
    {
      ...required(required(group, "Expected fixture value: group").checks[0], "Fixture check"),
      name: "setup",
      role: "setup",
    },
    {
      ...required(required(group, "Expected fixture value: group").checks[0], "Fixture check"),
      name: "secret",
      role: "secret",
      requiresSetup: false,
    },
  );
  const phases: string[][] = [];
  const run = (plan: ReturnType<typeof planChecks>) => {
    return promised(() => {
      phases.push(plan.sessions.flatMap((session) => session.checks.map((check) => check.role)));
    });
  };
  await f.run({}, run);
  await f.run({}, run);
  expect(phases).toEqual([["test", "setup", "secret"], ["secret"]]);
});

test("security checks and their setup run fresh on cache hits and failures propagate", async () => {
  const f = fixture();
  const group = f.plan.sessions[0];
  for (const role of ["setup", "docs", "secret"])
    required(group, "Expected fixture value: group").checks.push({
      ...required(required(group, "Expected fixture value: group").checks[0], "Fixture check"),
      name: role,
      role,
    });
  const phases: string[][] = [];
  const run = (plan: ReturnType<typeof planChecks>) => {
    return promised(() => {
      phases.push(plan.sessions.flatMap((session) => session.checks.map((check) => check.role)));
    });
  };
  await f.run({}, run);
  await f.run({}, run);
  expect(phases).toEqual([
    ["test", "setup", "docs", "secret"],
    ["setup", "secret"],
  ]);
  await expect(
    f.run({}, () => {
      return promised(() => {
        throw new Error("security failure");
      });
    }),
  ).rejects.toThrow("security failure");
  await f.run({}, run);
  expect(phases[2]).toEqual(["setup", "secret"]);
  await expect(
    f.run({}, () => {
      return promised(() => {
        writeFileSync(join(f.root, "source.txt"), "changed during refresh");
      });
    }),
  ).rejects.toThrow(/inputs changed/);
});

test.each([false, true])("working success satisfies a staged snapshot with external storage %s", async (external) => {
  const f = fixture();
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", String(external));
  const workingPaths = buildPaths(f.root, f.root, "native");
  vi.stubEnv("WORKBENCH_PRIVATE_INPUT", JSON.stringify(workingPaths.directory));
  await f.run();
  const snapshot = join(f.base, "snapshot");
  mkdirSync(snapshot);
  f.git("checkout-index", "--all", `--prefix=${snapshot}/`);
  writeFileSync(join(f.root, "source.txt"), "unstaged and unverified");
  vi.stubEnv("WORKBENCH_EPHEMERAL_CHECKOUT", "1");
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", f.root);
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", snapshot);
  const snapshotPaths = buildPaths(snapshot, snapshot, "native");
  vi.stubEnv("WORKBENCH_PRIVATE_INPUT", JSON.stringify(snapshotPaths.directory));
  expect(snapshotPaths.directory).not.toBe(workingPaths.directory);
  expect(snapshotPaths.dependencies).not.toBe(workingPaths.dependencies);
  const stagedPlan = {
    ...f.plan,
    sessions: [{ ...required(f.plan.sessions[0], "Fixture session"), directory: snapshot }],
  };
  await withCachedChecks(snapshot, {}, stagedPlan, f.action);
  expect(f.executions()).toBe(1);
});

test("unidentified managed environments and non-Git projects execute fresh without success receipts", async () => {
  const f = fixture();
  required(f.plan.sessions[0], "Expected fixture value: f.plan.sessions[0]").environment = "nix";
  await f.run();
  await f.run();
  required(f.plan.sessions[0], "Expected fixture value: f.plan.sessions[0]").environment = "native";
  rmSync(join(f.root, ".git"), { recursive: true });
  await f.run();
  expect(f.executions()).toBe(3);
  expect(inspectBuildCache(f.root).entries).toHaveLength(0);
});

test("unavailable pinned SDKs fail before running unrelated checks", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".go-version"), "1.27.1\n");
  f.git("add", ".");
  await expect(f.run()).rejects.toThrow(/Cannot verify go 1\.27\.1.*workbench tools install --path \./);
  expect(f.executions()).toBe(0);
});
