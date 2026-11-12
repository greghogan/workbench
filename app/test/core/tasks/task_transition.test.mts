import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { webFixture } from "../../fixtures/web.mjs";
import { ProjectEdits } from "../../../src/core/projects/project-edits.ts";
import { readTaskDecisions, taskDecisionPath } from "../../../src/core/tasks/task-decisions.ts";
import { changeTaskStatus } from "../../../src/core/tasks/task-service.ts";
import { git } from "../../fixtures/adoption.mjs";
import {
  publishTaskTransition,
  changeTaskQueue,
  readTaskQueue,
  taskQueuePath,
  withTaskLock,
} from "../../../src/core/tasks/task-queue.ts";

const fault = vi.hoisted(() => ({ file: "", state: "" }));
vi.mock("../../../src/core/runtime/file-publication.mjs", async (original) => {
  const actual = await original<typeof import("../../../src/core/runtime/file-publication.mjs")>();
  return {
    ...actual,
    publishFile: (...args: Parameters<typeof actual.publishFile>) => {
      if (args[0] === fault.file) throw new Error("Injected publication failure");
      actual.publishFile(...args);
    },
    writeAtomic: (...args: Parameters<typeof actual.writeAtomic>) => {
      if (args[0] === fault.state) throw new Error("Injected decision publication failure");
      actual.writeAtomic(...args);
    },
  };
});

test.each([false, true])(
  "interrupted approval recovery preserves later human decisions (same task: %s)",
  (sameTask) => {
    const root = webFixture(),
      checkout = mkdtempSync(join(tmpdir(), "workbench-decision-recovery-"));
    vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/state"));
    try {
      const config = join(root, "workbench/config.toml");
      writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
      mkdirSync(join(root, "workbench/tasks"));
      for (const id of [0, 1])
        writeFileSync(
          join(root, `workbench/tasks/TSK-0${String(id)}.md`),
          `---\nstatus: Planned\n---\n\n# TSK-${String(id)}: Review a plan\n`,
        );
      git(root, "add", ".");
      git(root, "commit", "-qm", "Plan baseline");
      git(root, "worktree", "add", "--detach", checkout, "HEAD");
      fault.state = taskDecisionPath(root);
      expect(() => {
        changeTaskStatus(root, "TSK-0", "Approved", undefined, true);
      }).toThrow(/Injected decision publication/);
      expect(readTaskDecisions(root)).toEqual([]);
      expect(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8")).toContain("status: Approved");
      expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(true);
      fault.state = "";
      const other = sameTask ? "TSK-0" : "TSK-1";
      changeTaskStatus(checkout, other, "Approved", undefined, true);
      if (sameTask) {
        // A newer revocation must remain effective even though both its visible receipts and the old state are empty.
        changeTaskStatus(checkout, other, "Planned");
        expect(() => {
          withTaskLock(root, () => undefined);
        }).toThrow(/human decisions changed/);
        expect(readTaskDecisions(root)).toEqual([]);
        expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(true);
      } else {
        withTaskLock(root, () => undefined);
        expect(
          readTaskDecisions(root)
            .map((decision) => decision.reference)
            .sort(),
        ).toEqual(["demo:TSK-0", "demo:TSK-1"]);
        expect(existsSync(taskQueuePath(root) + ".transition.json")).toBe(false);
      }
      expect(existsSync(taskQueuePath(root))).toBe(false);
    } finally {
      fault.state = "";
      vi.unstubAllEnvs();
      rmSync(checkout, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
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
