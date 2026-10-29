import { Worker } from "node:worker_threads";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { CacheTasks } from "../src/web/cache-worker.ts";
import { emptyInventory } from "../src/web/cache-inventory.ts";
import { waitForCondition } from "./fixtures/coordination.mjs";

test.each([false, true])(
  "cache cancellation reaps its real subprocess before releasing the worker (fragmented=%s)",
  async (fragmented) => {
    const directory = mkdtempSync(join(tmpdir(), "workbench-cache-cancel-"));
    const script = join(directory, "worker.mjs"),
      controller = new AbortController();
    const helper = pathToFileURL(resolve(import.meta.dirname, "../scripts/owned-child.mjs")).href;
    const partial = join(directory, "partial"),
      release = join(directory, "release");
    const child = `import {existsSync} from 'node:fs';
const line=String(process.pid)+'\\n';
if(process.argv[1]==='fragmented'){
 process.stdout.write(line.slice(0,1));
 while(!existsSync(process.argv[2]))await new Promise(resolve=>setTimeout(resolve,10));
 process.stdout.write(line.slice(1));
}else process.stdout.write(line);
setInterval(()=>{},1000);`;
    writeFileSync(
      script,
      `import {parentPort,workerData} from 'node:worker_threads';
import {runOwnedChild} from ${JSON.stringify(helper)};
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const cancellation=new AbortController();
parentPort.on('message',()=>cancellation.abort());
try {
 await runOwnedChild(process.execPath,['--input-type=module','-e',${JSON.stringify(child)},workerData.fragmented?'fragmented':'whole',workerData.release],{
  cwd:workerData.directory,env:process.env,signal:cancellation.signal,
  output:(stdout,stderr)=>{
   stdout.once('data',()=>writeFileSync(workerData.partial,'partial'));
   createInterface({input:stdout}).once('line',line=>parentPort.postMessage({progress:{kind:'metadata',value:{...workerData.inventory,uncertainConsumers:[line]}}}));
   stderr.resume();
  }
 });
 parentPort.postMessage({value:workerData.inventory});
} finally {parentPort.close();}
`,
    );
    const tasks = new CacheTasks(
      directory,
      () =>
        new Worker(script, { workerData: { directory, inventory: emptyInventory(), fragmented, partial, release } }),
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
      if (fragmented) {
        await waitForCondition(() => existsSync(partial), result, "first partial PID chunk");
        expect(pid).toBeUndefined();
        writeFileSync(release, "release");
      }
      await Promise.race([
        started,
        result.then(() => {
          throw new Error("Worker exited before publishing child readiness");
        }),
      ]);
      expect(pid).toBeGreaterThan(0);
      const childPid = pid;
      if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0)
        throw new Error("Invalid fixture child PID");
      controller.abort();
      await rejected;
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      controller.abort();
      await tasks.close();
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
