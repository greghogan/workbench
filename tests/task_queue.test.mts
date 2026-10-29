import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { webFixture } from "./fixtures/web.mjs";
import { readTaskGraph } from "../src/task-model.ts";
import { changeTaskStatus } from "../src/task-service.ts";
import { changeTaskQueue, inspectTaskQueue, readTaskQueue, taskQueuePath, withTaskLock } from "../src/task-queue.ts";
import { renderMap } from "../src/maps.ts";
import { readProjects } from "../src/project-configuration.ts";
import { required } from "../src/invariants.ts";
import { validateRelationships } from "../src/records.ts";

let root: string;
beforeEach(() => {
  root = webFixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function task(
  number: number,
  status = "Approved",
  fields = "",
  body = "## Overview\n\nA useful outcome.\n\n## Details\n\n- [x] Verify behavior.\n",
) {
  const path = join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`);
  writeFileSync(
    path,
    `---\n# Preserve this comment.\nstatus: ${status} # Human decision\n${fields}---\n\n# TSK-${String(number)}: Task ${String(number)}\n\n${body}`,
  );
  return path;
}
const queue = (action: Parameters<typeof changeTaskQueue>[1]) => changeTaskQueue(root, action);

test("queue selection, ordering and execution survive restart without changing task files", () => {
  const first = task(0),
    second = task(1);
  const original = [readFileSync(first, "utf8"), readFileSync(second, "utf8")];
  expect(existsSync(taskQueuePath(root))).toBe(false);
  expect(readTaskQueue(root).entries).toEqual([]);
  expect(existsSync(taskQueuePath(root))).toBe(false);
  queue({ action: "add", references: ["TSK-0", "demo:TSK-1"] });
  queue({ action: "move", reference: "TSK-1", before: "TSK-0" });
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-1", "demo:TSK-0"]);
  queue({ action: "start", reference: "TSK-1" });
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-0"]);
  expect(() => queue({ action: "remove", reference: "TSK-1" })).toThrow(/active/i);
  queue({ action: "implemented", reference: "TSK-1", detail: "All acceptance tests passed." });
  expect(readTaskQueue(root).entries[0]?.state).toBe("Implemented");
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-0"]);
  expect([readFileSync(first, "utf8"), readFileSync(second, "utf8")]).toEqual(original);
});

test("only approved work can enter the queue and a failed batch never partially publishes", () => {
  task(0);
  task(1, "Planned");
  expect(() => queue({ action: "add", references: ["TSK-0", "TSK-1"] })).toThrow(/approve/);
  expect(readTaskQueue(root).entries).toEqual([]);
  expect(() => queue({ action: "add", references: ["TSK-9"] })).toThrow(/not found/);
});

test("local verified dependencies unlock a batch, but acceptance requires shared accepted dependencies", () => {
  task(0);
  task(1, "Approved", "depends_on: [demo:TSK-0]\n");
  queue({ action: "add", references: ["TSK-1", "TSK-0"] });
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-0"]);
  expect(() => queue({ action: "start", reference: "TSK-1" })).toThrow(/Waiting/);
  queue({ action: "start", reference: "TSK-0" });
  queue({ action: "implemented", reference: "TSK-0", detail: "Tests passed." });
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-1"]);
  queue({ action: "start", reference: "TSK-1" });
  queue({ action: "implemented", reference: "TSK-1", detail: "Integration passed." });
  expect(() => {
    changeTaskStatus(root, "TSK-1", "Accepted");
  }).toThrow(/Waiting/);
  changeTaskStatus(root, "TSK-0", "Accepted");
  changeTaskStatus(root, "TSK-1", "Accepted");
  expect(inspectTaskQueue(root).ready).toEqual([]);
});

test("the queue tracks independent active work without choosing agent execution policy", () => {
  task(0);
  task(1);
  queue({ action: "add", references: ["TSK-0", "TSK-1"] });
  expect(inspectTaskQueue(root).ready).toEqual(["demo:TSK-0", "demo:TSK-1"]);
  queue({ action: "start", reference: "TSK-0" });
  queue({ action: "start", reference: "TSK-1" });
  expect(readTaskQueue(root)).not.toHaveProperty("mode");
  expect(() => queue({ action: "start", reference: "TSK-0" })).toThrow(/Already active/);
  queue({ action: "block", reference: "TSK-1", detail: "Needs a human answer." });
  expect(inspectTaskQueue(root).entries[1]?.blockers).toContain("Needs a human answer.");
  queue({ action: "release", reference: "TSK-1" });
});

test("stale queue forms and overlapping writers cannot overwrite another action", () => {
  task(0);
  const expected = inspectTaskQueue(root).digest;
  queue({ action: "add", references: ["TSK-0"] });
  expect(() => changeTaskQueue(root, { action: "start", reference: "TSK-0" }, expected)).toThrow(/changed/);
  withTaskLock(root, () => {
    expect(() => queue({ action: "start", reference: "TSK-0" })).toThrow(/lock|busy/i);
    expect(() => {
      changeTaskStatus(root, "TSK-0", "Accepted");
    }).toThrow(/lock|busy/i);
  });
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
});

test("human transitions preserve comments and body, reject stale approval and incomplete acceptance", () => {
  const path = task(0, "Planned"),
    before = readFileSync(path, "utf8");
  const digest = required(readTaskGraph(root).tasks[0], "task").digest;
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Accepted");
  }).toThrow(/Cannot change/);
  changeTaskStatus(root, "TSK-0", "Approved", digest);
  expect(readFileSync(path, "utf8")).toBe(before.replace("status: Planned", "status: Approved"));
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Accepted", digest);
  }).toThrow(/changed/);
  task(0, "Approved", "", "- [ ] Still unverified.\n");
  const unverified = readFileSync(path, "utf8");
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Accepted");
  }).toThrow(/unchecked/);
  expect(readFileSync(path, "utf8")).toBe(unverified);
});

test("acceptance rejects an implementation changed since its verification", () => {
  const path = task(0);
  queue({ action: "add", references: ["TSK-0"] });
  queue({ action: "start", reference: "TSK-0" });
  expect(() => queue({ action: "implemented", reference: "TSK-0", detail: " " })).toThrow(/evidence/);
  queue({ action: "implemented", reference: "TSK-0", detail: "Tests passed." });
  writeFileSync(path, readFileSync(path, "utf8") + "\nChanged the plan.\n");
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Accepted");
  }).toThrow(/Verify/);
  expect(inspectTaskQueue(root).entries[0]?.blockers.join(" ")).toMatch(/changed after verification/);
  changeTaskStatus(root, "TSK-0", "Planned");
  expect(readTaskQueue(root).entries[0]?.evidence).toBeUndefined();
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
});

test("parents aggregate children without inventing execution dependencies or flattening maps", () => {
  const parent = task(0, "Approved", "", "- [ ] demo:TSK-1: Child\n");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const graph = readTaskGraph(root);
  expect(graph.forest()[0]?.children[0]?.task.reference).toBe("demo:TSK-1");
  const map = renderMap(root, required(readProjects(root)[0], "project"), "TSK");
  expect(map).toMatch(/\n {2}- \[demo:TSK-1\]/);
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Accepted");
  }).toThrow(/child tasks/);
  changeTaskStatus(root, "TSK-1", "Accepted");
  expect(readFileSync(parent, "utf8")).toContain("- [x] demo:TSK-1 (Accepted): Child");
  changeTaskStatus(root, "TSK-0", "Accepted");
  expect(() => {
    changeTaskStatus(root, "TSK-1", "Planned");
  }).toThrow(/Reopen parent/);
});

test("missing relationships, combined cycles, and canceled dependencies remain blocking", () => {
  task(0, "Approved", "depends_on: [demo:TSK-1]\n");
  expect(() => readTaskGraph(root).tasks).toThrow(/not found/);
  task(1, "Approved", "parent: demo:TSK-0\ndepends_on: [demo:TSK-0]\n");
  expect(() => readTaskGraph(root).tasks).toThrow(/cycle/);
  task(1, "Canceled");
  queue({ action: "add", references: ["TSK-0"] });
  expect(inspectTaskQueue(root).ready).toEqual([]);
  expect(inspectTaskQueue(root).entries[0]?.blockers.join(" ")).toContain("Canceled");
});

test("accepted dependencies are validated for edited files and reopening cannot invalidate accepted outcomes", () => {
  task(0, "Approved");
  task(1, "Accepted", "depends_on: [demo:TSK-0]\n");
  expect(validateRelationships(root).join(" ")).toContain("accepted task has unaccepted dependency demo:TSK-0");
  task(0, "Accepted");
  expect(validateRelationships(root)).toEqual([]);
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Planned");
  }).toThrow(/Reopen accepted dependent/);
  changeTaskStatus(root, "TSK-1", "Planned");
  changeTaskStatus(root, "TSK-0", "Planned");
  expect(validateRelationships(root)).toEqual([]);
});

test("unknown queue fields, oversized evidence, and invalid reorder targets fail without discarding state", () => {
  task(0);
  queue({ action: "add", references: ["TSK-0"] });
  const before = readFileSync(taskQueuePath(root), "utf8");
  expect(() => queue({ action: "move", reference: "TSK-0", before: "TSK-9" })).toThrow(/different queued task/);
  queue({ action: "start", reference: "TSK-0" });
  expect(() => queue({ action: "implemented", reference: "TSK-0", detail: "x".repeat(16385) })).toThrow(
    /Invalid queue evidence/,
  );
  expect(readTaskQueue(root).entries[0]?.state).toBe("Active");
  writeFileSync(taskQueuePath(root), before.replace('"version": 1,', '"version": 1, "mystery": true,'));
  expect(() => readTaskQueue(root)).toThrow(/Unknown task queue field/);
});

test("linked child acceptance does not stale a parent's verified result", () => {
  task(0, "Approved", "", "- [ ] demo:TSK-1: Child\n");
  task(1, "Approved", "parent: demo:TSK-0\n");
  queue({ action: "add", references: ["TSK-1", "TSK-0"] });
  for (const reference of ["TSK-1", "TSK-0"]) {
    queue({ action: "start", reference });
    queue({ action: "implemented", reference, detail: "Verified the outcome." });
  }
  changeTaskStatus(root, "TSK-1", "Accepted");
  changeTaskStatus(root, "TSK-0", "Accepted");
  expect(readTaskGraph(root).tasks.map((task) => task.metadata.status)).toEqual(["Accepted", "Accepted"]);
});

test("shared transitions retain CRLF body bytes and active work must be released before replanning", () => {
  const path = task(0, "Planned"),
    original = readFileSync(path, "utf8").replaceAll("\n", "\r\n");
  writeFileSync(path, original);
  changeTaskStatus(root, "TSK-0", "Approved");
  expect(readFileSync(path, "utf8")).toBe(original.replace("status: Planned", "status: Approved"));
  queue({ action: "add", references: ["TSK-0"] });
  queue({ action: "start", reference: "TSK-0" });
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Planned");
  }).toThrow(/Block or release/);
  queue({ action: "block", reference: "TSK-0", detail: "Plan needs revision." });
  changeTaskStatus(root, "TSK-0", "Planned");
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
});

test("acceptance validates CRLF checklists and synchronization retains their original line endings", () => {
  const parent = task(0, "Approved", "", "- [ ] demo:TSK-1: Child\n");
  const child = task(1, "Approved", "parent: demo:TSK-0\n", "- [ ] Verify delivery.\n");
  for (const path of [parent, child]) writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));
  const before = readFileSync(child, "utf8");
  expect(() => {
    changeTaskStatus(root, "TSK-1", "Accepted");
  }).toThrow(/unchecked/);
  expect(readFileSync(child, "utf8")).toBe(before);
  writeFileSync(child, before.replace("[ ]", "[x]"));
  changeTaskStatus(root, "TSK-1", "Accepted");
  expect(readFileSync(parent, "utf8")).toContain("- [x] demo:TSK-1 (Accepted): Child\r\n");
  expect(readFileSync(parent, "utf8").replaceAll("\r\n", "")).not.toContain("\n");
});

test("a queue recovers a proven dead local writer while preserving uncertain ownership and all task data", () => {
  const path = task(0),
    contents = readFileSync(path, "utf8");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {dirname} from 'node:path';
    import {hostname} from 'node:os';
    import {randomUUID} from 'node:crypto';
    const lock=process.argv[1]+'.lock';
    mkdirSync(dirname(lock),{recursive:true}); mkdirSync(lock);
    writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID(),started:new Date().toISOString()}));
  `,
      taskQueuePath(root),
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  queue({ action: "add", references: ["TSK-0"] });
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:TSK-0");
  expect(existsSync(taskQueuePath(root) + ".lock")).toBe(false);
  mkdirSync(taskQueuePath(root) + ".lock");
  writeFileSync(taskQueuePath(root) + ".lock/owner.json", "{}\n");
  expect(() => queue({ action: "start", reference: "TSK-0" })).toThrow(/busy|recovery/);
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
  expect(existsSync(taskQueuePath(root) + ".lock/owner.json")).toBe(true);
});

test("a failed map publication preserves queue evidence and is recovered before the next mutation", () => {
  task(0);
  queue({ action: "add", references: ["TSK-0"] });
  queue({ action: "start", reference: "TSK-0" });
  queue({ action: "implemented", reference: "TSK-0", detail: "Verified before reopening" });
  const before = readTaskQueue(root);
  const map = join(root, "workbench/task-map.md");
  rmSync(map, { force: true });
  mkdirSync(map);
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Planned");
  }).toThrow();
  expect(readTaskQueue(root)).toEqual(before);
  expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(true);
  rmSync(map, { recursive: true });
  withTaskLock(root, () => undefined);
  expect(readTaskGraph(root).tasks[0]?.metadata.status).toBe("Planned");
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
  expect(readTaskQueue(root).entries[0]?.evidence).toBeUndefined();
  expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(false);
});

test("recovery refuses to overwrite edits made after an interrupted transition", () => {
  const path = task(0);
  const map = join(root, "workbench/task-map.md");
  mkdirSync(map);
  expect(() => {
    changeTaskStatus(root, "TSK-0", "Planned");
  }).toThrow();
  writeFileSync(path, readFileSync(path, "utf8") + "\nNew human notes.\n");
  rmSync(map, { recursive: true });
  expect(() => {
    withTaskLock(root, () => undefined);
  }).toThrow(/recovery conflicts/);
  expect(readFileSync(path, "utf8")).toContain("New human notes.");
  expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(true);
});
