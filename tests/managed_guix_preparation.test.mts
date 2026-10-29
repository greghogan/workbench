import { promised } from "./fixtures/promised.mjs";
import type { ManagedRunOptions } from "../scripts/managed-process.mjs";
import { required } from "../src/invariants.ts";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { guixChannelGroups } from "../scripts/managed-contract.mjs";
import { prepareGuixProfiles } from "../scripts/prepare-guix-profiles.mjs";
import { managedSystem } from "../scripts/managed-system.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(system = managedSystem(process.arch)) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-guix-groups-")));
  temporary.push(base);
  const roots = [".", "shared", "independent"].map((path, index) => {
    mkdirSync(join(base, path), { recursive: true });
    return { path, profile: join(base, `profile-${String(index)}`) };
  });
  writeFileSync(join(base, "channels.scm"), "project pin");
  writeFileSync(join(base, "independent/channels.scm"), "independent pin");
  const guix = guixChannelGroups(base, roots).map((group, index) => ({
    ...group,
    manager: join(base, `manager-${String(index)}`),
    runtime: join(base, `runtime-${String(index)}`),
    imageRoot: join(base, `image-${String(index)}`),
  }));
  const plan = {
    builder: "guix",
    system,
    cores: 2,
    maxJobs: 2,
    roots,
    guix,
    output: base,
    runtimeOwner: base,
    runtime: required(guix[0], "Expected fixture value: guix[0]").runtime,
    imageRoot: required(guix[0], "Expected fixture value: guix[0]").imageRoot,
  };
  const cleanups: (() => unknown)[] = [];
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const completed: string[] = [];
  const scope = {
    defer: (cleanup: () => unknown) => cleanups.push(cleanup),
    run(command: string, args: readonly string[], options: ManagedRunOptions = {}) {
      return promised(() => {
        calls.push({ command, args, env: options.env });
        if (args[0] === "time-machine") {
          const index = guix.findIndex((group) => group.channels === args[args.indexOf("-C") + 1]);
          const runtime = join(base, `real-runtime-${String(index)}`);
          mkdirSync(runtime);
          return runtime;
        }
        if (args[0] === "build") {
          const group = guix.find((group) => join(group.manager, "bin/guix") === command);
          const index = guix.indexOf(required(group, "Expected fixture value"));
          expect(required(options.env, "Managed environment").WORKBENCH_GUIX_TIME_MACHINE_PROFILE).toBe(
            join(
              base,
              `${system === managedSystem(process.arch) ? "real-runtime" : "real-target-runtime"}-${String(index)}`,
            ),
          );
          expect(required(options.env, "Managed environment").WORKBENCH_GUIX_PROFILES_FILE).toBeUndefined();
          const paths = JSON.parse(
            readFileSync(
              required(required(options.env, "Managed environment").WORKBENCH_ROOTS_FILE, "Roots path"),
              "utf8",
            ),
          ) as string[];
          expect(paths).toEqual(
            required(group, "Expected fixture value: group").roots.map(
              (root) => required(roots[root], "Expected fixture value: roots[root]").path,
            ),
          );
          const environments = join(base, `store-environments-${String(index)}`);
          mkdirSync(join(environments, "share/workbench/environments"), { recursive: true });
          for (const [local, path] of paths.entries()) {
            const profile = join(environments, "share/workbench/environments", String(local));
            mkdirSync(profile);
            writeFileSync(
              join(profile, "pin"),
              readFileSync(required(group, "Expected fixture value: group").channels),
            );
            completed.push(path);
          }
          symlinkSync(environments, required(group, "Expected fixture value: group").imageRoot);
          return environments;
        }
        if (args[0] === "repl" && args[2] === "profile-for-system") {
          const index = guix.findIndex((group) => join(group.manager, "bin/guix") === command);
          const runtime = join(base, `real-target-runtime-${String(index)}`);
          mkdirSync(runtime);
          return runtime;
        }
        return "";
      });
    },
  };
  return { base, plan, scope, calls, cleanups, completed };
}

test("image groups share the default pin and preserve independent profile and runtime ownership", async () => {
  const { base, plan, scope, calls, completed } = fixture();
  expect(plan.guix.map((group) => group.roots)).toEqual([[0, 1], [2]]);
  const env = await prepareGuixProfiles(plan, scope);
  const profiles = JSON.parse(readFileSync(required(env.WORKBENCH_GUIX_PROFILES_FILE, "Profiles path"), "utf8")) as {
    profile: string;
    runtime: string;
  }[];
  expect(profiles.map((entry: { profile: string }) => readFileSync(join(entry.profile, "pin"), "utf8"))).toEqual([
    "project pin",
    "project pin",
    "independent pin",
  ]);
  expect(profiles.map((entry) => entry.runtime)).toEqual([
    join(base, "real-runtime-0"),
    join(base, "real-runtime-0"),
    join(base, "real-runtime-1"),
  ]);
  expect(calls.filter((call) => call.args[0] === "time-machine")).toHaveLength(2);
  expect(completed.sort()).toEqual([".", "independent", "shared"]);
  expect(plan.guix.every((group) => !existsSync(group.imageRoot))).toBe(true);
});

test("failed channel groups settle their siblings and leave no complete image profile declaration", async () => {
  const { base, plan, scope, cleanups, completed } = fixture();
  const run = scope.run.bind(scope);
  scope.run = async (command, args, options) => {
    if (
      args[0] === "build" &&
      command === join(required(plan.guix[0], "Expected fixture value: plan.guix[0]").manager, "bin/guix")
    )
      throw new Error("group build failed");
    return run(command, args, options);
  };
  await expect(prepareGuixProfiles(plan, scope)).rejects.toThrow(/group build failed/);
  expect(completed).toEqual(["independent"]);
  expect(existsSync(join(base, "guix-profiles.json"))).toBe(false);
  for (const cleanup of cleanups.reverse()) await cleanup();
  expect(plan.guix.every((group) => !existsSync(group.imageRoot))).toBe(true);
});

test("an unavailable explicit channel declaration never falls back to the project pin", () => {
  const { base, plan } = fixture();
  symlinkSync(join(base, "missing-channel.scm"), join(base, "shared/channels.scm"));
  expect(() => guixChannelGroups(base, plan.roots)).toThrow(/ENOENT/);
});

test("foreign profiles retain native channel managers and target runtimes independently", async () => {
  const system = managedSystem(process.arch === "arm64" ? "x64" : "arm64");
  const { base, plan, scope, calls } = fixture(system);
  const env = await prepareGuixProfiles(plan, scope);
  expect(env.WORKBENCH_GUIX_MANAGER).toBe(join(base, "real-runtime-0"));
  expect(env.WORKBENCH_GUIX_TIME_MACHINE_PROFILE).toBe(join(base, "real-target-runtime-0"));
  for (const group of plan.guix) {
    expect(realpathSync(group.manager)).not.toBe(realpathSync(group.runtime));
    expect(
      calls.some(
        (call) => call.args[0] === "repl" && call.args[2] === "register-roots" && call.args.includes(group.manager),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.args[0] === "repl" && call.args[2] === "register-roots" && call.args.includes(group.runtime),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.command === join(group.manager, "bin/guix") && call.args.includes(`--system=${system}`),
      ),
    ).toBe(true);
  }
});
