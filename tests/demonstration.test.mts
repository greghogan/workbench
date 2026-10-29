import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDemonstration } from "../src/demonstration.ts";
import { readTaskGraph } from "../src/task-model.ts";
import { readTaskQueue, inspectTaskQueue, changeTaskQueue } from "../src/task-queue.ts";
import { changeTaskStatus } from "../src/task-service.ts";
import { validateRelationships } from "../src/records.ts";
import { distribution } from "./fixtures/adoption.mjs";

afterEach(() => vi.unstubAllEnvs());

/** The maintained demo is product test data; edits and personal state belong only to its disposable consumer. */
test("demonstration covers adaptive plans, grouped reviews, dependencies and the separate acceptance step", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", "");
  const source = join(distribution, "demo/workbench/tasks/TSK-07.md");
  const original = readFileSync(source, "utf8"),
    previousState = process.env.WORKBENCH_STATE_HOME;
  const demonstration = await createDemonstration(distribution);
  try {
    const graph = readTaskGraph(demonstration.root),
      tasks = graph.tasks,
      queue = readTaskQueue(demonstration.root);
    expect(new Set(tasks.map((task) => task.metadata.status))).toEqual(
      new Set(["Planned", "Approved", "Accepted", "Canceled"]),
    );
    expect(new Set(queue.entries.map((entry) => entry.state))).toEqual(
      new Set(["Queued", "Active", "Blocked", "Implemented"]),
    );
    expect(validateRelationships(demonstration.root)).toEqual([]);
    const plans = graph.forest();
    expect(
      plans.find((node) => node.task.reference === "demo:TSK-9")?.children.map((node) => node.task.reference),
    ).toEqual(["demo:TSK-A"]);
    expect(
      plans.find((node) => node.task.reference === "demo:TSK-8")?.children.map((node) => node.task.reference),
    ).toEqual(["demo:TSK-6", "demo:TSK-B"]);
    expect(graph.require("demo:TSK-9").contents).toContain("Open question:");
    expect(() => changeTaskQueue(demonstration.root, { action: "add", references: ["demo:TSK-9"] })).toThrow(/approve/);
    expect(
      inspectTaskQueue(demonstration.root)
        .entries.find((entry) => entry.reference === "demo:TSK-6")
        ?.blockers.join(" "),
    ).toContain("Waiting for demo:TSK-5");
    changeTaskQueue(demonstration.root, {
      action: "implemented",
      reference: "demo:TSK-5",
      detail: "Illustrative freshness verification completed for this test.",
    });
    expect(inspectTaskQueue(demonstration.root).ready).toEqual(["demo:TSK-6"]);
    changeTaskQueue(demonstration.root, { action: "start", reference: "demo:TSK-6" });
    changeTaskQueue(demonstration.root, {
      action: "implemented",
      reference: "demo:TSK-6",
      detail: "Illustrative parsing-boundary verification completed for this test.",
    });
    expect(inspectTaskQueue(demonstration.root).ready).toEqual(["demo:TSK-B"]);
    changeTaskStatus(demonstration.root, "demo:TSK-7", "Accepted");
    expect(readTaskGraph(demonstration.root).require("demo:TSK-7").metadata.status).toBe("Accepted");
    expect(readFileSync(source, "utf8")).toBe(original);
    const parent = readTaskGraph(demonstration.root).require("demo:TSK-9").contents;
    expect(parent).toContain("demo:TSK-A (Planned)");
  } finally {
    await demonstration.close();
  }
  expect(process.env.WORKBENCH_STATE_HOME).toBe(previousState);
  expect(process.env.WORKBENCH_DISTRIBUTION_ROOT).toBe("");
  expect(existsSync(demonstration.directory)).toBe(false);
});
