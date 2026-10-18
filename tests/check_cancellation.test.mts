import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CheckCancellation, ChecksCancelled } from "../src/check-cancellation.ts";
import { withBuildLock, buildLockDirectory } from "../src/builds.ts";
import { withToolCacheUseAsync, inspectToolCacheActivity } from "../src/tool-cache-lock.ts";
import { waitForCondition } from "./fixtures/coordination.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-cancellation-"));
  temporary.push(root);
  mkdirSync(join(root, "cache"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  return root;
}

test("direct checks retain locks and tool leases until cancellation cleanup finishes", async () => {
  const root = fixture();
  const script = join(root, "command.mjs");
  writeFileSync(
    script,
    `import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const mark=name=>writeFileSync(join(process.cwd(),name),'ready');
let stopping=false;
process.on('SIGINT',()=>{stopping=true;mark('cancel-requested')});
const interval=setInterval(()=>{
 if(stopping&&existsSync('release-cleanup')){
  clearInterval(interval);mark('done');process.exitCode=130;
 }
},10);
mark('running');`,
  );
  const paths: Pick<import("../src/builds.ts").BuildPaths, "identity"> = {
    identity: { checkout: root, root: ".", environment: "native", fingerprint: "a".repeat(24) },
  };
  const cancellation = new CheckCancellation();
  let settled = false,
    failure;
  const pending = withToolCacheUseAsync(
    () =>
      withBuildLock(paths, (owner) =>
        cancellation.execute([process.execPath, script], root, process.env, false, owner),
      ),
    [],
  ).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  try {
    await waitForCondition(() => existsSync(join(root, "running")), pending, "command ready");
    expect(existsSync(buildLockDirectory(paths.identity))).toBe(true);
    expect(inspectToolCacheActivity().uses).toHaveLength(1);
    cancellation.cancel();
    // Windows taskkill terminates the process tree immediately rather than asking for cooperative cleanup.
    if (process.platform !== "win32") {
      await waitForCondition(() => existsSync(join(root, "cancel-requested")), pending, "cancellation received");
      expect(settled).toBe(false);
      expect(existsSync(buildLockDirectory(paths.identity))).toBe(true);
      expect(inspectToolCacheActivity().uses).toHaveLength(1);
      writeFileSync(join(root, "release-cleanup"), "release");
    }
    await pending;
    expect(failure).toBeInstanceOf(ChecksCancelled);
    if (process.platform !== "win32") expect(existsSync(join(root, "done"))).toBe(true);
    expect(existsSync(buildLockDirectory(paths.identity))).toBe(false);
    expect(inspectToolCacheActivity().uses).toEqual([]);
  } finally {
    writeFileSync(join(root, "release-cleanup"), "release");
    cancellation.cancel();
    await pending;
    cancellation.close();
  }
});

test("cancelled checks never start a subsequent command", async () => {
  const root = fixture();
  const cancellation = new CheckCancellation();
  try {
    cancellation.cancel();
    await expect(
      cancellation.execute(
        [process.execPath, "-e", "require('node:fs').writeFileSync('started','unexpected')"],
        root,
        process.env,
      ),
    ).rejects.toBeInstanceOf(ChecksCancelled);
    expect(existsSync(join(root, "started"))).toBe(false);
  } finally {
    cancellation.close();
  }
});

test.skipIf(process.platform === "win32")(
  "cancellation still stops descendants after their command leader exits",
  async () => {
    const root = fixture();
    const script = join(root, "leader.mjs");
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('descendant',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
child.unref();writeFileSync('leader',String(process.pid));`,
    );
    const paths: Pick<import("../src/builds.ts").BuildPaths, "identity"> = {
      identity: { checkout: root, root: ".", environment: "native", fingerprint: "b".repeat(24) },
    };
    const cancellation = new CheckCancellation();
    let failure: unknown, leader: number | undefined;
    const pending = withBuildLock(paths, (owner) =>
      cancellation.execute([process.execPath, script], root, process.env, false, owner),
    ).catch((error: unknown) => {
      failure = error;
    });
    try {
      await waitForCondition(() => existsSync(join(root, "descendant")), pending, "descendant readiness");
      const leaderPid = Number(readFileSync(join(root, "leader"), "utf8"));
      leader = leaderPid;
      const descendant = Number(readFileSync(join(root, "descendant"), "utf8"));
      await waitForCondition(
        () => {
          try {
            process.kill(leaderPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        },
        pending,
        "leader exit",
      );
      // Deliver the leader's close event before canceling the still-owned descendant cleanup.
      await nextTurn();
      await nextTurn();
      expect(existsSync(buildLockDirectory(paths.identity))).toBe(true);
      cancellation.cancel();
      await pending;
      expect(failure).toBeInstanceOf(ChecksCancelled);
      expect(() => process.kill(descendant, 0)).toThrow();
      expect(existsSync(buildLockDirectory(paths.identity))).toBe(false);
    } finally {
      cancellation.cancel();
      if (leader !== undefined) {
        try {
          process.kill(-leader, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
      }
      await pending;
      cancellation.close();
    }
  },
);
