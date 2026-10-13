import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync, existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CILifecycle, executeCI } from "../src/ci-lifecycle.ts";
import { runCIWorkers } from "../src/local-ci-workers.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

test("one lifecycle observes signals during asynchronous preparation and drains the admitted command", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-lifecycle-"));
  const signals = new EventEmitter();
  const lifecycle = new CILifecycle(signals);
  const observer = watch(root);
  observer.on("change", (_event, file) => {
    if (file === "started") signals.emit("SIGTERM");
  });
  const script = join(root, "prepare.mjs");
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, "started"))},'started');\nawait new Promise(resolve=>setTimeout(resolve,30));\nwriteFileSync(${JSON.stringify(join(root, "finished"))},'finished');`,
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
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("log disk full"));
    },
  });
  fs.createWriteStream.mockImplementationOnce(() => {
    queueMicrotask(() => sink.emit("open"));
    return sink;
  });
  let recorded;
  try {
    await runCIWorkers(
      [
        {
          id: "verbose",
          log: join(root, "job.log"),
          start: async () => ({
            command: process.execPath,
            env: process.env,
            args: [
              "-e",
              `const fs=require('fs');for(let i=0;i<128;i++)process.stdout.write('x'.repeat(65536));fs.writeFileSync(${JSON.stringify(marker)},'finished');`,
            ],
          }),
          finish: async (error) => {
            recorded = error;
            expect(existsSync(marker)).toBe(true);
          },
        },
      ],
      1,
      lifecycle,
    );
    expect(recorded.message).toBe("log disk full");
  } finally {
    fs.createWriteStream.mockClear();
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruption stops job admission but drains admitted preparation, execution, and asynchronous cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-drain-"));
  const signals = new EventEmitter();
  const lifecycle = new CILifecycle(signals);
  const transitions = [];
  const worker = (id) => ({
    id,
    log: join(root, id + ".log"),
    start: async () => {
      transitions.push("prepare:" + id);
      signals.emit("SIGINT");
      await Promise.resolve();
      return { command: process.execPath, args: ["-e", "console.log('completed mutation')"], env: process.env };
    },
    finish: async (error) => {
      expect(error).toBeUndefined();
      await Promise.resolve();
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
