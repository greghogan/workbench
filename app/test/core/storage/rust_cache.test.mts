import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheProjectFixture } from "../../fixtures/cache-project.mjs";
import { buildPaths, prepareBuild, withBuildLock, withBuildUse } from "../../../src/core/artifacts/builds.ts";
import { CacheBusy } from "../../../src/core/storage/cache-lock.ts";
import { inspectRustCache, pruneRustCache } from "../../../src/core/storage/rust-cache.ts";
import type { ResultToolReference } from "../../../src/core/toolchains/tool-references.ts";
import { keepCacheAsset, updateProjectRequirements } from "../../../src/core/projects/project-registry.ts";
import { inspectBuildCache, pruneBuildCache } from "../../../src/core/storage/build-cache.ts";
import { recordResultTools } from "../../../src/core/toolchains/tool-references.ts";
import { pruneRustCommand } from "../../../src/cli/rust-cache-command.ts";
import { autoPrune, pruneAfterGate } from "../../../src/core/storage/auto-prune.ts";
import { runCommandAsync } from "../../../src/core/execution/checks/check-command.ts";
import { CheckCancellation, ChecksCancelled } from "../../../src/core/execution/checks/check-cancellation.ts";
import { waitForCondition } from "../../fixtures/coordination.mts";

const fixtures: ReturnType<typeof cacheProjectFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const day = 86_400_000;
function fixture() {
  const f = cacheProjectFixture();
  fixtures.push(f);
  const root = f.project("rust");
  const paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  const directory = join(paths.directory, "cargo");
  mkdirSync(directory);
  const now = Date.now();
  const reference: ResultToolReference = {
    directory: paths.directory,
    storageRoot: paths.storageRoot,
    identity: paths.identity,
    kind: "builds",
    tools: [{ tool: "rust", version: "1.99.1" }],
    platform: `${process.platform}-${process.arch}`,
    verifiedAt: new Date(now).toISOString(),
  };
  const file = (name: string, contents: string, age: number) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    const time = new Date(now - age * day);
    utimesSync(path, time, time);
    return path;
  };
  const artifact = (hash: string, age: number, bytes = 100, profile = "debug") => {
    const names = [
      file(`${profile}/.fingerprint/demo-${hash}/lib-demo.json`, "{}", age),
      file(`${profile}/deps/libdemo-${hash}.rlib`, "r".repeat(bytes), age),
      file(`${profile}/build/demo-${hash}/output`, "build", age),
    ];
    return { id: `${profile}/${hash}`, names, bytes: bytes + 7 };
  };
  const incremental = (session: string, age: number, bytes = 100) => {
    const path = `debug/incremental/demo-crate/${session}`;
    file(path + "/query-cache.bin", "q".repeat(bytes), age);
    file(`debug/incremental/demo-crate/${session.split("-").slice(0, 3).join("-")}.lock`, "", age);
    return path;
  };
  const unit = (hash: string, age: number, profile = "debug", packageName = "demo") => {
    const path = `${profile}/build/${packageName}/${hash}`;
    const names = [
      file(`${path}/fingerprint/lib-demo.json`, "{}", age),
      file(`${path}/out/libdemo.rlib`, "compiled", age),
      file(`${path}/run/stdout`, "build output", age),
    ];
    return { id: path, names };
  };
  return { ...f, root, paths, directory, now, reference, file, artifact, incremental, unit };
}

test("build-unit pruning handles mixed layouts and target profiles without removing recent, unknown, or unsafe output", async () => {
  const f = fixture(),
    legacy = f.artifact("1111111111111111", 20),
    old = f.unit("2222222222222222", 20),
    recent = f.unit("3333333333333333", 1),
    target = f.unit("4444444444444444", 20, "aarch64-unknown-linux-gnu/release"),
    custom = f.unit("5555555555555555", 20, "custom"),
    unsafe = f.unit("6666666666666666", 20);
  const incremental = f.incremental("s-old-aaa-one", 20);
  const outside = join(f.base, "source");
  writeFileSync(outside, "user source");
  symlinkSync(outside, join(f.directory, unsafe.id, "out/source"));
  const unknown = f.file("debug/build/notes/7777777777777777/out/notes", "preserve", 20),
    nested = f.unit("8888888888888888", 20, "other/nested/project"),
    binary = f.file("debug/demo", "final executable", 20);
  const result = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(new Set(result.selected.map((group) => group.id))).toEqual(
    new Set([legacy.id, old.id, target.id, custom.id, incremental]),
  );
  for (const group of [legacy, old, target, custom]) expect(group.names.some(existsSync)).toBe(false);
  for (const group of [recent, unsafe, nested]) expect(group.names.every(existsSync)).toBe(true);
  expect(readFileSync(unknown, "utf8")).toBe("preserve");
  expect(readFileSync(binary, "utf8")).toBe("final executable");
  expect(readFileSync(outside, "utf8")).toBe("user source");
});

test("a new-layout package name matching a legacy hash does not make cleanup groups overlap", async () => {
  const f = fixture(),
    legacy = f.artifact("1111111111111111", 20),
    unit = f.unit("2222222222222222", 1, "debug", "demo-1111111111111111");
  const result = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(result.selected.map((group) => group.id)).toEqual([legacy.id]);
  expect(unit.names.every(existsSync)).toBe(true);
});

test("retained incremental sessions remain eligible after their build units have been pruned", async () => {
  const f = fixture(),
    unit = f.unit("1111111111111111", 20),
    session = f.incremental("s-new-aaa-one", 1);
  f.file("debug/.cargo-build-lock", "", 1);
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(unit.names.some(existsSync)).toBe(false);
  expect(existsSync(join(f.directory, session))).toBe(true);
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now + 8 * day });
  expect(existsSync(join(f.directory, session))).toBe(false);
});

test("age pruning selects complete Cargo groups and stale incremental sessions, preserving final and unknown outputs", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20),
    fresh = f.artifact("2222222222222222", 1);
  const oldSession = f.incremental("s-old-aaa-one", 20),
    current = f.incremental("s-new-bbb-two", 1);
  const binary = f.file("debug/demo", "finished executable", 20),
    unknown = f.file("debug/deps/user-notes.txt", "preserve", 20);
  const preview = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { now: f.now });
  expect(new Set(preview.selected.map((entry) => entry.id))).toEqual(new Set([old.id, oldSession]));
  expect(existsSync(join(f.directory, ".workbench-rust-usage.json"))).toBe(false);
  expect(old.names.every(existsSync)).toBe(true);
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(old.names.some(existsSync)).toBe(false);
  expect(existsSync(join(f.directory, oldSession))).toBe(false);
  expect(existsSync(join(f.directory, "debug/incremental/demo-crate/s-old-aaa.lock"))).toBe(false);
  expect(fresh.names.every(existsSync)).toBe(true);
  expect(existsSync(join(f.directory, current))).toBe(true);
  expect(readFileSync(binary, "utf8")).toBe("finished executable");
  expect(readFileSync(unknown, "utf8")).toBe("preserve");
});

test("size pruning removes the least recently active whole groups and retains the newest incremental session", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 5),
    current = f.artifact("2222222222222222", 1);
  const older = f.incremental("s-old-aaa-one", 5),
    newest = f.incremental("s-new-bbb-two", 1);
  const result = await inspectRustCache(f.directory, { maxAgeDays: 0, maxBytes: current.bytes + 100 }, f.now);
  expect(new Set(result.selected.map((entry) => entry.id))).toEqual(new Set([old.id, older]));
  expect(result.remainingBytes).toBe(current.bytes + 100);
  expect(result.groups.find((group) => group.id === newest)?.protected).toBe(true);
  const small = await inspectRustCache(f.directory, { maxAgeDays: 0, maxBytes: 1 }, f.now);
  expect(small.remainingBytes).toBe(100);
  expect(small.selected.some((group) => group.id === newest)).toBe(false);
});

test("cross-target profiles and custom profiles are pruned without treating unrelated nested folders as Cargo output", async () => {
  const f = fixture(),
    target = f.artifact("1111111111111111", 20, 100, "aarch64-unknown-linux-gnu/release"),
    custom = f.artifact("2222222222222222", 20, 100, "custom");
  const unrelated = f.file("other/nested/project/.fingerprint/demo-1111111111111111/source", "notes", 20);
  const plan = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(new Set(plan.selected.map((group) => group.id))).toEqual(new Set([target.id, custom.id]));
  expect(readFileSync(unrelated, "utf8")).toBe("notes");
});

test("working or unfamiliar incremental sessions remain intact", async () => {
  const f = fixture();
  const completed = f.incremental("s-old-aaa-one", 20);
  const working = f.file("debug/incremental/demo-crate/s-running-ccc-working/query-cache.bin", "active", 20);
  const unknown = f.file("debug/incremental/unknown/notes", "preserve", 20);
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 1 }, { apply: true, now: f.now });
  expect(existsSync(join(f.directory, completed))).toBe(true);
  expect(readFileSync(working, "utf8")).toBe("active");
  expect(readFileSync(unknown, "utf8")).toBe("preserve");
});

test("symlinked artifact members never become deletion candidates or lead outside owned storage", async () => {
  const f = fixture(),
    artifact = f.artifact("1111111111111111", 20);
  const outside = join(f.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "source"), "user data");
  symlinkSync(
    outside,
    join(f.directory, "debug/build/demo-1111111111111111/source"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const plan = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 1 }, { apply: true, now: f.now });
  expect(plan.selected).toEqual([]);
  expect(artifact.names.every(existsSync)).toBe(true);
  expect(readFileSync(join(outside, "source"), "utf8")).toBe("user data");
});

test("corrupt usage metadata, wrong ownership, and explicit retention fail before any artifact is removed", async () => {
  const f = fixture(),
    artifact = f.artifact("1111111111111111", 20);
  await expect(
    pruneRustCache(
      { ...f.reference, identity: { ...f.reference.identity, root: "wrong" } },
      { maxAgeDays: 7, maxBytes: 0 },
      { apply: true },
    ),
  ).rejects.toThrow();
  keepCacheAsset(f.paths.directory, true);
  await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(CacheBusy);
  keepCacheAsset(f.paths.directory, false);
  writeFileSync(join(f.directory, ".workbench-rust-usage.json"), '{"version":999,"groups":{}}');
  await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(
    /usage metadata/,
  );
  expect(artifact.names.every(existsSync)).toBe(true);
});

test("observed artifact changes refresh usage without making inspection itself renew access", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  await pruneRustCache(f.reference, { maxAgeDays: 0, maxBytes: 0 }, { apply: true, now: f.now });
  writeFileSync(old.names[1] ?? "", "changed build result");
  const time = new Date(f.now - 20 * day);
  utimesSync(old.names[1] ?? "", time, time);
  const changed = await inspectRustCache(f.directory, { maxAgeDays: 7, maxBytes: 0 }, f.now);
  expect(changed.selected).toEqual([]);
  await pruneRustCache(f.reference, { maxAgeDays: 0, maxBytes: 0 }, { apply: true, now: f.now });
  expect(
    (await inspectRustCache(f.directory, { maxAgeDays: 7, maxBytes: 0 }, f.now + 8 * day)).selected.map(
      (group) => group.id,
    ),
  ).toEqual([old.id]);
});

test("active check ownership and shared development sessions block both selective and whole-generation pruning", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  const original = inspectBuildCache(undefined, false, f.root, f.paths.storageRoot);
  await withBuildLock(f.paths, async () => {
    await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(
      CacheBusy,
    );
  });
  await withBuildUse(f.paths, async () => {
    expect(inspectBuildCache(undefined, false, f.root, f.paths.storageRoot).entries[0]?.blockedBy).toBeTruthy();
    await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(
      CacheBusy,
    );
    await expect(pruneBuildCache({ report: original, apply: true })).rejects.toThrow(CacheBusy);
    expect(withBuildLock(f.paths, () => "nested check")).toBe("nested check");
  });
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, now: f.now });
  expect(old.names.some(existsSync)).toBe(false);
});

test("interrupted launch uncertainty remains a cleanup blocker instead of expiring", async () => {
  const f = fixture();
  f.artifact("1111111111111111", 20);
  await expect(
    withBuildUse(f.paths, (owner) => {
      owner.beforeSpawn();
      return Promise.reject(new Error("launch interrupted"));
    }),
  ).rejects.toThrow();
  await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(CacheBusy);
});

test.each([false, true])(
  "development commands protect Rust output through exit or cancellation (cancel=%s)",
  async (cancel) => {
    const f = fixture(),
      old = f.artifact("1111111111111111", 20);
    const ready = join(f.root, "ready"),
      release = join(f.root, "release");
    const script = join(f.root, "hold.cjs");
    writeFileSync(
      script,
      "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'ready');const timer=setInterval(()=>{if(fs.existsSync(process.argv[3]))clearInterval(timer)},20);\n",
    );
    const cancellation = new CheckCancellation("Fixture development command");
    const command = runCommandAsync(
      cancellation,
      f.root,
      "fixture development command",
      [process.execPath, script, ready, release],
      "native",
      f.root,
    );
    // Observe rejection immediately while waiting on the explicit child-ready barrier.
    const outcome = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitForCondition(() => existsSync(ready), command, "development command ready");
      await expect(pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true })).rejects.toThrow(
        CacheBusy,
      );
      expect(old.names.every(existsSync)).toBe(true);
      if (cancel) cancellation.cancel();
      else writeFileSync(release, "release");
      if (cancel) expect(await outcome).toBeInstanceOf(ChecksCancelled);
      else expect(await outcome).toBeUndefined();
      await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true });
      expect(old.names.some(existsSync)).toBe(false);
    } finally {
      cancellation.cancel();
      await outcome;
      cancellation.close();
    }
  },
);

test("reviewed cleanup digests reject later filesystem changes before deleting any reviewed artifacts", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  const preview = await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 });
  f.file("debug/new-output", "a later build", 0);
  await expect(
    pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true, expected: preview.digest }),
  ).rejects.toThrow(/fresh cleanup preview/);
  expect(old.names.every(existsSync)).toBe(true);
});

test("a selected member changed during final policy validation prevents the entire deletion set", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  let calls = 0;
  await expect(
    pruneRustCache(
      f.reference,
      { maxAgeDays: 7, maxBytes: 0 },
      {
        apply: true,
        validate: () => {
          if (++calls === 2) writeFileSync(old.names[1] ?? "", "changed after selection");
        },
      },
    ),
  ).rejects.toThrow(/changed during cleanup/);
  expect(old.names.every(existsSync)).toBe(true);
});

test("cancellation before deletion preserves artifacts and releases cleanup ownership", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  const controller = new AbortController();
  let validations = 0;
  await expect(
    pruneRustCache(
      f.reference,
      { maxAgeDays: 7, maxBytes: 0 },
      {
        apply: true,
        signal: controller.signal,
        validate: () => {
          if (++validations === 2) controller.abort(new Error("cancelled fixture cleanup"));
        },
      },
    ),
  ).rejects.toThrow("cancelled fixture cleanup");
  expect(old.names.every(existsSync)).toBe(true);
  await pruneRustCache(f.reference, { maxAgeDays: 7, maxBytes: 0 }, { apply: true });
  expect(old.names.some(existsSync)).toBe(false);
});

test("manual Rust cleanup previews fresh metadata and applies the reviewed selection even when automatic pruning is disabled", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20);
  recordResultTools(f.reference);
  mkdirSync(join(f.base, "config"), { recursive: true });
  writeFileSync(join(f.base, "config/config.toml"), "[cache]\nauto_prune=false\n");
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    output.push(line);
  });
  await pruneRustCommand(f.root, { json: true });
  expect(output[0]).toContain('"applied": false');
  expect(output[0]).toContain(old.id);
  expect(old.names.every(existsSync)).toBe(true);
  await pruneRustCommand(f.root, { json: true, apply: true });
  expect(output[1]).toContain('"applied": true');
  expect(old.names.some(existsSync)).toBe(false);
});

test("successful registered Rust results participate in automatic pruning, with the user preference taking precedence", async () => {
  const f = fixture(),
    old = f.artifact("1111111111111111", 20),
    recent = f.artifact("2222222222222222", 0);
  recordResultTools(f.reference);
  const tool = { tool: "rust", version: "1.99.1", root: ".", profile: "" };
  updateProjectRequirements(f.root, [tool], "", [tool]);
  mkdirSync(join(f.base, "config"), { recursive: true });
  writeFileSync(join(f.base, "config/config.toml"), "[cache]\nauto_prune=false\n");
  expect(await autoPrune(f.root)).toBe("skipped");
  expect(old.names.every(existsSync)).toBe(true);
  writeFileSync(join(f.base, "config/config.toml"), "[cache]\nauto_prune=true\n");
  expect(await pruneAfterGate(f.root)).toBe("finished");
  expect(old.names.some(existsSync)).toBe(false);
  expect(recent.names.every(existsSync)).toBe(true);
  expect(await pruneAfterGate(f.root)).toBe("finished");
  expect(await pruneAfterGate(f.root)).toBe("skipped");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 8 * day);
  expect(await pruneAfterGate(f.root)).toBe("finished");
  expect(recent.names.some(existsSync)).toBe(false);
});
