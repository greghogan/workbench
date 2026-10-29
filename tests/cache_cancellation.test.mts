import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { CacheTasks } from "../src/web/cache-worker.ts";
import { emptyInventory } from "../src/web/cache-inventory.ts";

test("cache cancellation reaps its real subprocess before releasing the worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-cache-cancel-"));
  const script = join(directory, "worker.mjs"),
    controller = new AbortController();
  const helper = pathToFileURL(resolve(import.meta.dirname, "../scripts/owned-child.mjs")).href;
  writeFileSync(
    script,
    `import {parentPort,workerData} from 'node:worker_threads';
import {runOwnedChild} from ${JSON.stringify(helper)};
const cancellation=new AbortController();
parentPort.on('message',()=>cancellation.abort());
try {
 await runOwnedChild(process.execPath,['-e','process.stdout.write(String(process.pid));setInterval(()=>{},1000);'],{
  cwd:workerData.directory,env:process.env,signal:cancellation.signal,
  output:(stdout,stderr)=>{stdout.once('data',chunk=>parentPort.postMessage({progress:{kind:'metadata',value:{...workerData.inventory,uncertainConsumers:[chunk.toString()]}}}));stderr.resume();}
 });
 parentPort.postMessage({value:workerData.inventory});
} finally {parentPort.close();}
`,
  );
  const tasks = new CacheTasks(
    directory,
    () => new Worker(script, { workerData: { directory, inventory: emptyInventory() } }),
  );
  let pid: number | undefined;
  let ready: () => void = () => {
    throw new Error("Missing readiness promise");
  };
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = tasks.run(
    { kind: "inventory" },
    (event) => {
      if (event.kind === "metadata") {
        pid = Number(event.value.uncertainConsumers[0]);
        ready();
      }
    },
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  try {
    await Promise.race([
      started,
      result.then(() => {
        throw new Error("Worker exited before publishing child readiness");
      }),
    ]);
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await rejected;
    expect(() => process.kill(pid ?? 0, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    controller.abort();
    await tasks.close();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
