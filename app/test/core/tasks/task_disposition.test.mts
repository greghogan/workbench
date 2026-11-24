import {
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
  finishAgentCommit,
  AgentReviewKind,
} from "../../../src/core/review/agent-review.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures/adoption.mjs";
import { webFixture } from "../../fixtures/web.mjs";
import { taskDisposition, applyTaskDisposition } from "../../../src/core/tasks/task-disposition.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = webFixture();
  roots.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/private-state"));
  return root;
}
function delivery(root: string, number: number, source: string) {
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(
    join(root, `workbench/tasks/TSK-${String(number).padStart(2, "0")}.md`),
    `---\nstatus: Approved\n---\n\n# TSK-${String(number)}: Useful work\n\n${source}\n`,
  );
  writeFileSync(join(root, `source-${String(number)}.txt`), source + "\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", `Delivery ${String(number)}\n\nWorkbench-Provisional: true`);
  return git(root, "rev-parse", "HEAD");
}

test("task deletion previews its whole unpublished suffix and preserves original history for recovery", () => {
  const root = fixture(),
    base = git(root, "rev-parse", "HEAD"),
    first = delivery(root, 0, "First delivery.");
  writeFileSync(
    join(root, "workbench/tasks/TSK-00.md"),
    readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8") + "\nRefined the implementation.\n",
  );
  writeFileSync(join(root, "source-0.txt"), "Refined.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Refinement\n\nWorkbench-Provisional: true");
  const head = git(root, "rev-parse", "HEAD"),
    plan = taskDisposition(root, "demo:TSK-0", "delete");
  expect(plan.problems).toEqual([]);
  expect(plan.commits).toEqual([head, first]);
  expect(plan.updates.some((file) => file.path === "source-0.txt")).toBe(true);
  const reviewed = proposedAgentReview(root, AgentReviewKind.Changes, { tasks: ["demo:TSK-0"] });
  reviewed.summary = "Fixture delivery reviewed";
  reviewed.verification = "Fixture assertions";
  recordAgentReview(root, reviewed, reviewIdentity(reviewed));
  finishAgentCommit(root);
  const hooks = join(root, ".git/fault-hooks"),
    selectedBranch = git(root, "symbolic-ref", "HEAD");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\nif [ "$1" = prepared ]; then\nwhile read -r old new ref; do\n[ "$ref" != "${selectedBranch}" ] || exit 1\ndone\nfi\n`,
  );
  chmodSync(join(hooks, "reference-transaction"), 0o755);
  git(root, "config", "core.hooksPath", hooks);
  expect(() =>
    applyTaskDisposition(root, { reference: "demo:TSK-0", kind: "delete", expected: plan.digest }),
  ).toThrow();
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  rmSync(join(hooks, "reference-transaction"));
  git(root, "gc", "--prune=now");
  const recovery = applyTaskDisposition(root, { recover: true });
  expect(git(root, "rev-parse", "HEAD")).toBe(base);
  expect(proposedAgentReview(root, AgentReviewKind.Task, { base }).tasks).not.toContain("demo:TSK-0");
  expect(existsSync(join(root, "source-0.txt"))).toBe(false);
  expect(git(root, "show", `${recovery}/before:source-0.txt`)).toBe("Refined.");
  expect(git(root, "status", "--porcelain=v1")).toBe("");
});

test("reversion retains task history and an outcome awaiting verification while preserving later unrelated work", () => {
  const root = fixture();
  delivery(root, 0, "Deliver a feature.");
  writeFileSync(join(root, "independent.txt"), "Keep later work.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Independent work");
  const head = git(root, "rev-parse", "HEAD");
  expect(taskDisposition(root, "demo:TSK-0", "delete").problems.join(" ")).toContain("unmixed task suffix");
  const originalPlan = readTaskGraph(root).require("demo:TSK-0").planDigest;
  const plan = taskDisposition(root, "demo:TSK-0", "revert", "The feature is no longer wanted.");
  expect(plan.problems).toEqual([]);
  applyTaskDisposition(root, { reference: "demo:TSK-0", kind: "revert", reason: plan.reason, expected: plan.digest });
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(existsSync(join(root, "source-0.txt"))).toBe(false);
  const task = readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8");
  expect(task).toContain("status: Approved");
  expect(task).toContain("The feature is no longer wanted.");
  expect(readTaskGraph(root).require("demo:TSK-0").planDigest).toBe(originalPlan);
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
  expect(changeTaskQueue(root, { action: "start", reference: "demo:TSK-0" }).entries[0]?.state).toBe("Active");
  expect(readFileSync(join(root, "independent.txt"), "utf8")).toBe("Keep later work.\n");
  expect(git(root, "show", ":workbench/tasks/TSK-00.md")).toContain("The feature is no longer wanted.");
});

test("mixed task commits and published history cannot be deleted as an isolated task", () => {
  const root = fixture();
  delivery(root, 0, "Original work.");
  const remote = join(root, ".git/remote.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-qu", "origin", "HEAD:main");
  const plan = taskDisposition(root, "demo:TSK-0", "delete");
  expect(plan.problems.join(" ")).toContain("Published task history");
  expect(() => applyTaskDisposition(root, { reference: "demo:TSK-0", kind: "delete", expected: plan.digest })).toThrow(
    /Published/,
  );
  delivery(root, 1, "Other task.");
  writeFileSync(
    join(root, "workbench/tasks/TSK-00.md"),
    readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8") + "\nMixed with another task.\n",
  );
  writeFileSync(
    join(root, "workbench/tasks/TSK-01.md"),
    readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8") + "\nMixed update.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Mixed work");
  expect(taskDisposition(root, "demo:TSK-0", "revert", "Undo it.").problems.join(" ")).toContain("other task work");
});

test.each(["delete", "revert"] as const)("%s preserves another task's decision or executable mode", (kind) => {
  const root = fixture();
  delivery(root, 1, "Separate work.");
  const other = join(root, "workbench/tasks/TSK-01.md");
  writeFileSync(other, readFileSync(other, "utf8").replace("status: Approved", "status: Accepted"));
  delivery(root, 0, "Selected work.");
  const head = git(root, "rev-parse", "HEAD"),
    index = git(root, "write-tree"),
    plan = taskDisposition(root, "demo:TSK-0", kind, "Undo only the selected work.");
  expect(plan.problems.join(" ")).toContain("other task work");
  expect(() =>
    applyTaskDisposition(root, { reference: "demo:TSK-0", kind, reason: plan.reason, expected: plan.digest }),
  ).toThrow(/other task work/);
  expect(readFileSync(other, "utf8")).toContain("status: Accepted");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "write-tree")).toBe(index);
});

test.each(["delete", "revert"] as const)("%s preserves another task's mode-only change", (kind) => {
  const root = fixture();
  delivery(root, 1, "Separate work.");
  const other = "workbench/tasks/TSK-01.md";
  git(root, "config", "core.filemode", "false");
  git(root, "update-index", "--chmod=+x", other);
  delivery(root, 0, "Selected work.");
  expect(taskDisposition(root, "demo:TSK-0", kind, "Undo selected work.").problems.join(" ")).toContain(
    "other task work",
  );
  expect(git(root, "ls-files", "--stage", other)).toMatch(/^100755 /);
});
