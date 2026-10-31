import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createOwnedScratch, recoverScratch } from "../scripts/owned-scratch.mjs";
import { runOwnedChild } from "../scripts/owned-child.mjs";
import { waitForCondition } from "./fixtures/coordination.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function parent() {
  const path = mkdtempSync(join(tmpdir(), "workbench-owned-scratch-"));
  roots.push(path);
  return path;
}
test("active and unmarked directories survive recovery; a dead marked owner is reclaimed", () => {
  const root = parent(),
    active = createOwnedScratch(root, "coverage");
  const foreign = join(root, "coverage-user-data");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "valuable"), "preserve");
  expect(recoverScratch(root, "coverage")).toEqual([]);
  const module = pathToFileURL(resolve(import.meta.dirname, "../scripts/owned-scratch.mjs")).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {createOwnedScratch} from ${JSON.stringify(module)};const scratch=createOwnedScratch(process.argv[1],"coverage");process.stdout.write(scratch.directory);`,
      root,
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  const abandoned = child.stdout;
  writeFileSync(join(abandoned, "large-raw-profile"), "raw data");
  expect(recoverScratch(root, "coverage")).toContain(abandoned.slice(root.length + 1));
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(active.directory)).toBe(true);
  expect(readFileSync(join(foreign, "valuable"), "utf8")).toBe("preserve");
  active.release();
});
test("cancelled children drain before scratch release; ambiguous launches retain data", async () => {
  const root = parent(),
    scratch = createOwnedScratch(root, "coverage"),
    controller = new AbortController();
  const ready = join(scratch.directory, "ready");
  const running = runOwnedChild(
    process.execPath,
    ["-e", `require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`, ready],
    { cwd: scratch.directory, env: process.env, signal: controller.signal, owner: scratch.owner },
  );
  for (let count = 0; !existsSync(ready); count++) {
    if (count > 1000) throw new Error("Child readiness watchdog");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  controller.abort();
  const result = await running;
  expect(result.status).not.toBe(0);
  scratch.release();
  expect(existsSync(scratch.directory)).toBe(false);
  const uncertain = createOwnedScratch(root, "coverage");
  uncertain.owner.beforeSpawn();
  expect(() => {
    uncertain.release();
  }).toThrow(/active/);
  expect(existsSync(uncertain.directory)).toBe(true);
  uncertain.owner.spawned(undefined, false);
  uncertain.release();
});

test("output setup failure drains the child before releasing its scratch", async () => {
  const scratch = createOwnedScratch(parent(), "coverage");
  const result = await runOwnedChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: scratch.directory,
    env: process.env,
    signal: new AbortController().signal,
    owner: scratch.owner,
    output: () => {
      throw new Error("log setup failed");
    },
  });
  expect(result.error?.message).toBe("log setup failed");
  scratch.release();
  expect(existsSync(scratch.directory)).toBe(false);
});

test.each(["cancel", "drain"] as const)(
  "owned stdin commands honor %s shutdown before releasing scratch",
  async (shutdown) => {
    const scratch = createOwnedScratch(parent(), "coverage");
    const controller = new AbortController();
    const ready = join(scratch.directory, "ready"),
      release = join(scratch.directory, "release"),
      result = join(scratch.directory, "result");
    const running = runOwnedChild(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {writeFileSync,existsSync} from 'node:fs';
    let input='';for await (const chunk of process.stdin) input+=chunk;
    writeFileSync(process.argv[1],'ready');
    while(!existsSync(process.argv[2])) await new Promise(resolve=>setTimeout(resolve,10));
    writeFileSync(process.argv[3],input);
  `,
        ready,
        release,
        result,
      ],
      {
        cwd: scratch.directory,
        env: process.env,
        signal: controller.signal,
        owner: scratch.owner,
        input: "admitted mutation input",
        shutdown,
        output: (stdout, stderr) => {
          stdout.resume();
          stderr.resume();
        },
      },
    );
    try {
      await waitForCondition(() => existsSync(ready), running, "owned command admission");
      expect(() => {
        scratch.release();
      }).toThrow(/active/);
      controller.abort();
      if (shutdown === "drain") writeFileSync(release, "continue");
      const outcome = await running;
      if (shutdown === "drain") {
        expect(outcome.status).toBe(0);
        expect(readFileSync(result, "utf8")).toBe("admitted mutation input");
      } else {
        expect(outcome.status).not.toBe(0);
        expect(existsSync(result)).toBe(false);
      }
      scratch.release();
    } finally {
      if (existsSync(scratch.directory)) writeFileSync(release, "continue");
      await running;
    }
  },
);
