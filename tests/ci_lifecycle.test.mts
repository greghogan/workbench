import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CILifecycle, executeCI } from "../src/ci-lifecycle.ts";
import { runCIWorkers } from "../src/local-ci-workers.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

test("one lifecycle observes signals during asynchronous preparation and drains the admitted command", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-lifecycle-"));
  const signals = new EventEmitter();
  const lifecycle = new CILifecycle(signals);
  const observer = watch(root);
  observer.on("change", (_event, file) => {
    if (file === "started") {
      signals.emit("SIGTERM");
      writeFileSync(join(root, "observed"), "signal observed");
    }
  });
  const script = join(root, "prepare.mjs");
  writeFileSync(
    script,
    `import {writeFileSync,existsSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, "started"))},'started');\nconst deadline=Date.now()+15000;while(!existsSync(${JSON.stringify(join(root, "observed"))})){if(Date.now()>deadline)throw new Error('signal was not observed');await new Promise(resolve=>setTimeout(resolve,10));}\nwriteFileSync(${JSON.stringify(join(root, "finished"))},'finished');`,
  );
  try {
    await executeCI(process.execPath, [script]);
    expect(existsSync(join(root, "finished"))).toBe(true);
    expect(lifecycle.interrupted).toBe(true);
    await expect(lifecycle.checkpoint()).rejects.toThrow(/active mutations/);
    await expect(
      executeCI(process.execPath, ["-e", "console.error('meaningful failure');process.exit(2)"], { capture: true }),
    ).rejects.toThrow(/meaningful failure/);
    await expect(executeCI(join(root, "missing-command"), [])).rejects.toThrow(/failed/);
  } finally {
    observer.close();
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

test("a failed job log drains verbose child output and records the failure after the mutation finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-log-failure-"));
  const lifecycle = new CILifecycle(new EventEmitter());
  const marker = join(root, "mutation-finished");
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.createWriteStream).mockImplementationOnce((path, options) => {
    const sink = actual.createWriteStream(path, options);
    sink._write = (_chunk, _encoding, callback) => {
      callback(new Error("log disk full"));
    };
    return sink;
  });
  let recorded: Error | undefined;
  try {
    await runCIWorkers(
      [
        {
          id: "verbose",
          log: join(root, "job.log"),
          start: () =>
            promised(() => ({
              command: process.execPath,
              env: process.env,
              args: [
                "-e",
                `const fs=require('fs');for(let i=0;i<128;i++)process.stdout.write('x'.repeat(65536));fs.writeFileSync(${JSON.stringify(marker)},'finished');`,
              ],
            })),
          finish: (error: Error | undefined) => {
            return promised(() => {
              recorded = error;
              expect(existsSync(marker)).toBe(true);
            });
          },
        },
      ],
      1,
      lifecycle,
    );
    expect(required(recorded, "Expected fixture value: recorded").message).toBe("log disk full");
  } finally {
    vi.mocked(fs.createWriteStream).mockClear();
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruption stops job admission but drains admitted preparation, execution, and asynchronous cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-drain-"));
  const signals = new EventEmitter();
  const lifecycle = new CILifecycle(signals);
  const transitions: string[] = [];
  const worker = (id: string) => ({
    id,
    log: join(root, id + ".log"),
    start: async () => {
      transitions.push("prepare:" + id);
      signals.emit("SIGINT");
      await Promise.resolve(undefined);
      return { command: process.execPath, args: ["-e", "console.log('completed mutation')"], env: process.env };
    },
    finish: async (error: Error | undefined) => {
      expect(error).toBeUndefined();
      await Promise.resolve(undefined);
      transitions.push("cleanup:" + id);
    },
  });
  try {
    await runCIWorkers([worker("first"), worker("queued")], 1, lifecycle);
    expect(transitions).toEqual(["prepare:first", "cleanup:first"]);
    expect(existsSync(join(root, "queued.log"))).toBe(false);
    expect(lifecycle.interrupted).toBe(true);
  } finally {
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
