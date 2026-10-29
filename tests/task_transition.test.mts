import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { webFixture } from "./fixtures/web.mjs";
import { ProjectEdits } from "../src/project-edits.ts";
import {
  publishTaskTransition,
  changeTaskQueue,
  readTaskQueue,
  taskQueuePath,
  withTaskLock,
} from "../src/task-queue.ts";

const fault = vi.hoisted(() => ({ file: "" }));
vi.mock("../scripts/file-publication.mjs", async (original) => {
  const actual = await original<typeof import("../scripts/file-publication.mjs")>();
  return {
    ...actual,
    publishFile: (...args: Parameters<typeof actual.publishFile>) => {
      if (args[0] === fault.file) throw new Error("Injected publication failure");
      actual.publishFile(...args);
    },
  };
});
test("a file publication failure rolls back records without discarding local implementation evidence", () => {
  const root = webFixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/state"));
  try {
    mkdirSync(join(root, "workbench/tasks"));
    const task = join(root, "workbench/tasks/TSK-00.md"),
      contents = "---\nstatus: Approved\n---\n\n# TSK-0: Retain evidence\n";
    writeFileSync(task, contents);
    changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
    changeTaskQueue(root, { action: "start", reference: "TSK-0" });
    changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Verified" });
    const before = readTaskQueue(root),
      after = { ...before, revision: before.revision + 1, entries: [] };
    const edits = new ProjectEdits(root);
    edits.write("workbench/tasks/TSK-00.md", contents.replace("Approved", "Planned"));
    edits.write("other.txt", "second publication");
    fault.file = join(root, "other.txt");
    expect(() => {
      withTaskLock(root, () => {
        publishTaskTransition(root, edits, before, after);
      });
    }).toThrow(/Injected publication/);
    expect(readFileSync(task, "utf8")).toBe(contents);
    expect(readTaskQueue(root)).toEqual(before);
    expect(existsSync(fault.file)).toBe(false);
    fault.file = "";
    withTaskLock(root, () => undefined);
    expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(false);
    expect(readTaskQueue(root)).toEqual(before);
  } finally {
    fault.file = "";
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
