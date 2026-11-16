import { expect, test, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers } from "../../fixtures/web.mjs";
import { git, distribution } from "../../fixtures/adoption.mjs";
import { prepareTaskReview } from "../../../src/core/tasks/task-formatting.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { changeTaskStatus } from "../../../src/core/tasks/task-service.ts";
import { readTaskDecisions } from "../../../src/core/tasks/task-decisions.ts";
import { readTaskPlanApproval } from "../../../src/core/tasks/task-approvals.ts";
import { ReviewFormatter } from "../../../src/core/review/review-formatting.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";
import { planIdentity } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { savePlanDraft, approvePlanDraft } from "../../../src/core/tasks/planning/planning-operations.ts";

const servers = webServers();
const prose = "Preserve existing user work while preparing and restarting the service. ".repeat(12).trim();

test("task review formats its working record and map without rewriting the approved snapshot, evidence, or index", async () => {
  const root = servers.project();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks/TSK-00"), { recursive: true });
  const path = join(root, "workbench/tasks/TSK-00.md"),
    sidecar = join(root, "workbench/tasks/TSK-00/evidence.md");
  writeFileSync(path, `---\nstatus: Planned\n---\n\n# TSK-0: Service review\n\n${prose}\n`);
  writeFileSync(sidecar, prose);
  changeTaskStatus(root, "demo:TSK-0", "Approved", undefined, true);
  const task = readTaskGraph(root).require("demo:TSK-0"),
    decision = readTaskDecisions(root).find((entry) => entry.status === "Approved");
  if (!decision) throw new Error("Missing approval");
  const snapshot = readTaskPlanApproval(root, decision),
    staged = git(root, "write-tree");
  await prepareTaskReview(root, task.reference, task.reviewDigest ?? task.digest);
  expect(readFileSync(path, "utf8")).toBe(await formatDocument(task.contents, path, 120));
  expect(readTaskGraph(root).require(task.reference).approval?.current).toBe(true);
  expect(readTaskPlanApproval(root, decision)).toEqual(snapshot);
  expect(readTaskDecisions(root)).toEqual([decision]);
  expect(readFileSync(sidecar, "utf8")).toBe(prose);
  expect(git(root, "write-tree")).toBe(staged);
  expect(readFileSync(join(root, "workbench/task-map.md"), "utf8")).toContain("Service review");
});

test("formatting a saved plan preserves exact approval and rejects a concurrent replacement draft", async () => {
  const root = servers.project();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const identity = planIdentity("demo", "service"),
    original = `---\nstatus: Planned\n---\n\n# Service review\n\n${prose}\n`;
  let plan = savePlanDraft(root, identity, original);
  approvePlanDraft(root, identity, plan.digest, true);
  plan = readPlan(root, identity);
  const approval = plan.approval,
    staged = git(root, "write-tree");
  await prepareTaskReview(root, identity.reference, plan.digest);
  const formatted = readPlan(root, identity);
  expect(formatted.contents).toBe(await formatDocument(plan.contents, "plan.md", 120));
  expect(formatted.approval).toEqual(approval);
  expect(formatted.approval?.current).toBe(true);
  expect(git(root, "write-tree")).toBe(staged);
  const unformatted = savePlanDraft(root, identity, plan.contents, { expected: formatted.digest });
  const prepare = vi.spyOn(ReviewFormatter.prototype, "prepare").mockImplementationOnce(() => {
    const changed = savePlanDraft(root, identity, original.replace("Service review", "Concurrent service plan"), {
      expected: unformatted.digest,
    });
    return Promise.resolve({ state: "changed", formatted: changed.contents + "\n" });
  });
  try {
    await expect(prepareTaskReview(root, identity.reference, unformatted.digest)).rejects.toThrow(/changed/);
    expect(readPlan(root, identity).document?.title).toBe("Concurrent service plan");
    expect(readPlan(root, identity).approval?.contents).toBe(approval?.contents);
  } finally {
    prepare.mockRestore();
  }
});
