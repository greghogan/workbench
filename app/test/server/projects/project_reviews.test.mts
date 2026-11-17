import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { webServers } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { ReviewInventory } from "../../../src/server/projects/review-inventory.ts";
import { ProjectReviews } from "../../../src/server/projects/project-reviews.ts";
import { WorkspaceCollector, WorkspaceIndex } from "../../../src/server/workspace/workspace-service.ts";
import { checkReviewFormatting } from "../../../src/server/workspace/review-preparation.ts";
import { ReviewFormatter, formatPendingReviews } from "../../../src/core/review/review-formatting.ts";
import { approveReviewFiles, reviewStatus, ReviewSource } from "../../../src/core/review/review-service.ts";
import { changeTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { changeTaskStatus } from "../../../src/core/tasks/task-service.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";

const fixtures = webServers();
test("lightweight counts agree with document queues across supporting files, acknowledgments, formatting and baseline changes", async () => {
  const root = fixtures.project(),
    reader = new ReviewInventory(root);
  const decision = join(root, "workbench/decisions/ADR-00.md");
  const original = readFileSync(decision, "utf8");
  const compare = async (expected: number) => {
    const snapshot = await checkReviewFormatting(new WorkspaceCollector(root).collect(), new ReviewFormatter());
    expect(new WorkspaceIndex(snapshot).select({}).pendingReviews).toBe(expected);
    expect((await reader.collect()).count).toBe(expected);
  };
  await compare(0);
  writeFileSync(decision, original + "\nA changed decision.\n");
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, "workbench/decisions/ADR-00/evidence.txt"), "evidence\n");
  mkdirSync(join(root, "workbench/experiments"));
  writeFileSync(
    join(root, "workbench/experiments/EXP-00.md"),
    "---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: Draft\n",
  );
  await compare(1);
  await formatPendingReviews(root);
  approveReviewFiles(root, reviewStatus(root, ReviewSource.Working).changes, true, ReviewSource.Working);
  await compare(0);
  writeFileSync(decision, original + "\n" + "A long paragraph that needs reflow. ".repeat(10) + "\n");
  approveReviewFiles(root, reviewStatus(root, ReviewSource.Working).changes, true, ReviewSource.Working);
  await compare(1);
  await formatPendingReviews(root);
  approveReviewFiles(root, reviewStatus(root, ReviewSource.Working).changes, true, ReviewSource.Working);
  await compare(0);
  git(root, "add", ".");
  git(root, "commit", "-qm", "New baseline");
  git(root, "checkout", "--detach", "-q");
  await compare(0);
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "unrelated oversized task\n".repeat(100_000));
  writeFileSync(join(root, "workbench/decisions/ADR-01.md"), original.replaceAll("ADR-0", "ADR-1"));
  expect((await reader.collect()).count).toBe(1);
});

test("cold and open review counts follow task outcomes, revised approval and supporting-file invalidation", async () => {
  const root = fixtures.project(),
    reader = new ReviewInventory(root),
    directory = join(root, "workbench/tasks");
  mkdirSync(directory);
  const path = join(directory, "TSK-00.md");
  writeFileSync(path, "---\nstatus: Planned\n---\n\n# TSK-0: Recover work\n\nKeep progress after restart.\n");
  const approve = () => {
    changeTaskStatus(root, "TSK-0", "Approved", readTaskGraph(root).tasks[0]?.reviewDigest, true);
  };
  const compare = async (expected: number) => {
    const snapshot = await checkReviewFormatting(new WorkspaceCollector(root).collect(), new ReviewFormatter());
    expect(new WorkspaceIndex(snapshot).select({}).pendingReviews).toBe(expected);
    expect((await reader.collect()).count).toBe(expected);
  };
  await compare(0);
  approve();
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Recovery verified." });
  await compare(1);
  mkdirSync(join(directory, "TSK-00"));
  mkdirSync(join(directory, "TSK-00/details"));
  await compare(1);
  writeFileSync(join(directory, "TSK-00/details/requirement.md"), "Preserve pending work.\n");
  await compare(0);
  approve();
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Supporting requirement verified." });
  await compare(1);
  // Invalid unrelated records do not hide independently actionable outcomes.
  writeFileSync(join(directory, "TSK-01.md"), "invalid task\n");
  await compare(1);
  writeFileSync(join(directory, "TSK-01.md"), "---\nstatus: Planned\n---\n\n# TSK-1: Future work\n");
  changeTaskStatus(root, "TSK-0", "Accepted", undefined, true);
  await compare(0);
});

class ControlledWorker extends EventEmitter {
  requests: { id: string; path: string; generation: number }[] = [];
  postMessage(input: unknown) {
    if (input && typeof input === "object" && "generation" in input)
      this.requests.push(input as (typeof this.requests)[number]);
  }
  terminate = vi.fn(() => {
    this.emit("exit", 0);
    return Promise.resolve(0);
  });
  complete(count: number) {
    this.emit("message", { ...this.requests.at(-1), count, inputs: [] });
  }
}
const projects = ["a", "b", "c", "d"].map((id) => ({ id: id.repeat(24), path: `/fixture/${id}` }));
test("a stalled summary does not block the queue, superseded results cannot publish, and failures affect only outstanding work", async () => {
  const workers: ControlledWorker[] = [],
    updates: { id: string; count?: number; problem?: string }[] = [];
  const reviews = new ProjectReviews(
    "/unused",
    (id, value) => {
      updates.push({ id, ...value });
    },
    () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  );
  try {
    reviews.read(projects);
    expect(workers).toHaveLength(2);
    const [slow, fast] = workers;
    if (!slow || !fast) throw new Error("Missing summary workers");
    fast.complete(1);
    expect(fast.requests.at(-1)?.id).toBe(projects[2]?.id);
    fast.complete(2);
    fast.complete(3);
    expect(updates.map((value) => value.count)).toEqual([1, 2, 3]);
    reviews.invalidate(projects[0]?.id);
    slow.complete(99);
    expect(updates).toHaveLength(3);
    expect(slow.requests).toHaveLength(2);
    slow.emit("exit", 1);
    const counts = reviews.read(projects);
    expect(counts.get(projects[0]?.id ?? "")?.problem).toContain("exited");
    expect(counts.get(projects[1]?.id ?? "")).toMatchObject({ count: 1 });
    expect(counts.get(projects[1]?.id ?? "")?.problem).toBeUndefined();
    reviews.read([]);
    expect(fast.terminate).toHaveBeenCalledOnce();
    expect(reviews.read([]).size).toBe(0);
  } finally {
    await reviews.close();
  }
});
