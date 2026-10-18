import { required } from "../src/invariants.ts";
import type { ChildProcess } from "child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test("separate synchronous and asynchronous cache installers exclude each other and reuse the accepted result", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-cache-processes-"));
  const script = join(root, "installer.mjs");
  const events = join(root, "events.jsonl");
  const destination = join(root, "tool");
  const module = pathToFileURL(join(import.meta.dirname, "../src/cache-lock.ts")).href;
  writeFileSync(events, "");
  writeFileSync(
    script,
    `
import { withCacheLock, withCacheLockSync } from ${JSON.stringify(module)};
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [mode, destination, events, gate, id] = process.argv.slice(2);
const event = type => appendFileSync(events, JSON.stringify({id,type})+'\\n');
const action = () => {
  event('enter'); process.send('entered');
  while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  const receipt = destination+'.accepted';
  if (!existsSync(receipt)) { event('install'); writeFileSync(receipt,'verified installation'); }
  else if (readFileSync(receipt,'utf8') !== 'verified installation') throw Error('invalid installation');
  event('exit');
};
process.send('ready');
await new Promise(resolve => process.once('message',resolve));
process.send('attempt');
if(mode === 'sync') withCacheLockSync(destination,action);
else await withCacheLock(destination, async () => action());
process.disconnect();
`,
  );
  const workers: {
    child: ChildProcess;
    gate: string;
    outcome: Promise<unknown>;
    wait: (message: string) => Promise<unknown>;
  }[] = [];
  function launch(mode: string, id: string) {
    const gate = join(root, `gate-${id}`);
    const child = spawn(process.execPath, [script, mode, destination, events, gate, id], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const messages: string[] = [];
    const notifications = new EventEmitter();
    let stderr = "";
    required(child.stderr, "Expected fixture value: child.stderr").on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("message", (message) => {
      if (typeof message !== "string") throw new Error("Unexpected worker notification");
      messages.push(message);
      notifications.emit(message);
    });
    const outcome = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`installer ${id}: ${String(code)}: ${stderr}`));
      });
    });
    // Observe failures immediately while the parent coordinates startup.
    void outcome.catch(() => undefined);
    const wait = (message: string) =>
      messages.includes(message)
        ? Promise.resolve(undefined)
        : Promise.race([
            new Promise((resolve) => {
              notifications.once(message, resolve);
            }),
            outcome.then(() => {
              if (!messages.includes(message)) throw new Error(`missing ${message}`);
            }),
          ]);
    const worker = { child, gate, outcome, wait };
    workers.push(worker);
    return worker;
  }
  try {
    const first = launch("async", "first");
    await first.wait("ready");
    first.child.send("go");
    await first.wait("entered");
    const others = [launch("sync", "second"), launch("async", "third")];
    for (const worker of others) {
      writeFileSync(worker.gate, "continue");
      await worker.wait("ready");
      worker.child.send("go");
      await worker.wait("attempt");
    }
    expect(existsSync(`${destination}.accepted`)).toBe(false);
    writeFileSync(first.gate, "continue");
    await Promise.all(workers.map((worker) => worker.outcome));
    let active = 0;
    const entered = [];
    const recorded = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text) as { type: string; id: string });
    for (const event of recorded) {
      if (event.type === "enter") {
        active++;
        entered.push(event.id);
      }
      if (event.type === "exit") active--;
      expect(active).toBeGreaterThanOrEqual(0);
      expect(active).toBeLessThanOrEqual(1);
    }
    expect(active).toBe(0);
    expect(entered.toSorted()).toEqual(["first", "second", "third"]);
    expect(recorded.filter((event) => event.type === "install")).toEqual([{ id: "first", type: "install" }]);
    expect(readFileSync(`${destination}.accepted`, "utf8")).toBe("verified installation");
    expect(existsSync(`${destination}.lock`)).toBe(false);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.allSettled(workers.map((worker) => worker.outcome));
    rmSync(root, { recursive: true, force: true });
  }
});
