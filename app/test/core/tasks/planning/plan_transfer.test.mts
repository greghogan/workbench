import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { webFixture } from "../../../fixtures/web.mjs";
import { git, distribution } from "../../../fixtures/adoption.mjs";
import { planIdentity } from "../../../../src/core/tasks/planning/plan-model.ts";
import {
  configurePlanning,
  savePlanDraft,
  approvePlanDraft,
  checkpointPlans,
} from "../../../../src/core/tasks/planning/planning-operations.ts";
import { readPlan, readPlans } from "../../../../src/core/tasks/planning/planning-store.ts";
import { readPlanOperations } from "../../../../src/core/tasks/planning/plan-operation-store.ts";
import { finishPlanTransfers } from "../../../../src/core/tasks/planning/plan-retirement.ts";
import { renamePlan, resumePlanRename } from "../../../../src/core/tasks/planning/plan-rename.ts";
import { startPlan, resumePlanTransfer } from "../../../../src/core/tasks/planning/plan-transfer.ts";
import { changeTaskQueue, readTaskQueue } from "../../../../src/core/tasks/task-queue.ts";
import { readTaskGraph } from "../../../../src/core/tasks/task-model.ts";
import { readWorkGraph } from "../../../../src/core/tasks/planning/work-plans.ts";
import { readTaskDecisions } from "../../../../src/core/tasks/task-decisions.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(storage = true) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = webFixture();
  roots.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/private-state"));
  if (storage) configurePlanning(root, { branch: "future", auto_prune: true });
  return root;
}
const service = planIdentity("demo", "service");
function approved(root: string, name = service, metadata = "") {
  const draft = savePlanDraft(
    root,
    name,
    `---\nstatus: Planned\n${metadata}---\n\n# Background service\n\nInstall a service for the current user.\n\n[Notes](files/notes.md)\n\n[Multiline](\n files/notes.md#details\n)\n\n[Self](#background-service)\n\n\`[Example](files/notes.md)\`\n`,
    {
      files: new Map([
        ["schema.bin", { contents: Buffer.from([0, 255, 3]), executable: true }],
        [
          "notes.md",
          {
            contents: Buffer.from(
              "# Details\n\nUses demo:plan/service.\n\n[Input](schema.bin)\n[Plan](../plan.md#background-service)\n",
            ),
            executable: false,
          },
        ],
      ]),
    },
  );
  const view = approvePlanDraft(root, name, draft.digest, true);
  changeTaskQueue(root, { action: "add", references: [name.reference] });
  return view;
}
test("starting an approved plan creates its numeric task, preserves exact approval and assets, and leaves source history and unrelated edits alone", async () => {
  const root = fixture(),
    original = approved(root),
    head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "unrelated.txt"), "Keep this staged change.\n");
  git(root, "add", "unrelated.txt");
  const index = git(root, "write-tree"),
    reference = await startPlan(root, service.reference),
    graph = readTaskGraph(root),
    task = graph.require(reference);
  expect(reference).toBe("demo:TSK-0");
  expect(task.contents).toContain("# TSK-0: Background service");
  expect(task.metadata.status).toBe("Approved");
  expect(task.metadata.added_at).toBe(original.document?.metadata.added_at);
  expect(task.contents).toContain("[Notes](TSK-00/notes.md)");
  expect(task.contents).toContain("[Multiline](TSK-00/notes.md#details)");
  expect(task.contents).toContain("[Self](TSK-00.md#tsk-0-background-service)");
  expect(task.contents).toContain("`[Example](files/notes.md)`");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00/notes.md"), "utf8")).toContain("Uses demo:TSK-0");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00/notes.md"), "utf8")).toContain(
    "[Plan](../TSK-00.md#tsk-0-background-service)",
  );
  expect(readFileSync(join(root, "workbench/tasks/TSK-00/schema.bin"))).toEqual(Buffer.from([0, 255, 3]));
  expect(task.approval?.current).toBe(true);
  expect(readTaskDecisions(root).find((decision) => decision.reference === reference)?.updated).toBe(
    original.approval?.at,
  );
  expect(readTaskQueue(root).entries.map((entry) => [entry.reference, entry.state])).toEqual([[reference, "Active"]]);
  expect(readWorkGraph(root).byReference.has(service.reference)).toBe(false);
  expect(readPlan(root, service).contents).toBe(original.contents);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "write-tree")).toBe(index);
  expect(() => {
    savePlanDraft(root, service, "Unrelated replacement", { expected: original.digest });
  }).toThrow(/implementation copy is authoritative/);
  await expect(startPlan(root, service.reference)).rejects.toThrow(/already started/);
});
test("a captured transfer survives Git collection before source publication and recovers once without reserving a second identity", async () => {
  const root = fixture();
  approved(root);
  await expect(
    startPlan(root, service.reference, undefined, {
      onRecorded: () => {
        throw new Error("Interrupted before publication");
      },
    }),
  ).rejects.toThrow(/Interrupted/);
  expect(existsSync(join(root, "workbench/tasks/TSK-00.md"))).toBe(false);
  const operation = readPlanOperations(root)[0];
  if (!operation) throw new Error("Missing durable transfer");
  expect(operation.operation.completed).toBe(false);
  expect(() => {
    savePlanDraft(root, planIdentity("demo", "other"), "Other work");
  }).toThrow(/requires recovery/);
  git(root, "gc", "--prune=now");
  expect(resumePlanTransfer(root, operation.operation.id)).toBe("demo:TSK-0");
  expect(resumePlanTransfer(root, operation.operation.id)).toBe("demo:TSK-0");
  expect(readTaskGraph(root).tasks.map((task) => task.reference)).toEqual(["demo:TSK-0"]);
  expect(readTaskQueue(root).entries[0]?.state).toBe("Active");
  expect(readPlanOperations(root)[0]?.operation.completed).toBe(true);
});
test("starting a child retains its unapproved ancestor as context and leaves sibling plans outside implementation", async () => {
  const root = fixture(),
    parent = planIdentity("demo", "service-family"),
    sibling = planIdentity("demo", "second-service");
  savePlanDraft(root, parent, "---\nstatus: Planned\n---\n\n# Service family\n\nManage related services.\n");
  savePlanDraft(
    root,
    sibling,
    `---\nstatus: Planned\nparent: ${parent.reference}\n---\n\n# Second service\n\nPlan this later.\n`,
  );
  approved(root, service, `parent: ${parent.reference}\n`);
  expect(await startPlan(root, service.reference)).toBe("demo:TSK-1");
  const graph = readTaskGraph(root);
  expect(graph.require("demo:TSK-0").metadata.status).toBe("Planned");
  expect(graph.require("demo:TSK-1").parent).toBe("demo:TSK-0");
  expect(readTaskDecisions(root).some((decision) => decision.reference === "demo:TSK-0")).toBe(false);
  expect(graph.tasks).toHaveLength(2);
  expect(readPlan(root, sibling).contents).toContain("Plan this later.");
  expect(readWorkGraph(root).require(sibling.reference).parent).toBe("demo:TSK-0");
});

test("retirement waits for the first implementation commit, recovers after interruption, and checkpoints only related changes", async () => {
  const root = fixture(),
    original = approved(root),
    dependent = planIdentity("demo", "consumer"),
    unrelated = planIdentity("demo", "other");
  const dependentDraft = savePlanDraft(
    root,
    dependent,
    `---\nstatus: Planned\ndepends_on:\n  - ${service.reference}\n---\n\n# Consumer\n\nUses ${service.reference}, unlike ${service.reference}-extra.\n`,
  );
  const dependentApproval = approvePlanDraft(root, dependent, dependentDraft.digest, true);
  savePlanDraft(root, unrelated, "---\nstatus: Planned\n---\n\n# Other\n\nUnrelated work.\n");
  const before = git(root, "rev-parse", "future");
  await startPlan(root, service.reference);
  expect(finishPlanTransfers(root)).toEqual([]);
  expect(readPlan(root, service).contents).toBe(original.contents);
  git(root, "add", "workbench");
  git(root, "commit", "-qm", "Implement service");
  const head = git(root, "rev-parse", "HEAD"),
    index = git(root, "write-tree");
  expect(() =>
    finishPlanTransfers(root, "HEAD", {
      onPrepared: () => {
        throw new Error("Interrupted retirement");
      },
    }),
  ).toThrow(/Interrupted retirement/);
  git(root, "gc", "--prune=now");
  expect(finishPlanTransfers(root)).toEqual(["demo:TSK-0"]);
  expect(finishPlanTransfers(root)).toEqual([]);
  expect(readPlanOperations(root)).toEqual([]);
  expect(readPlans(root).map((plan) => plan.reference)).toEqual([dependent.reference, unrelated.reference]);
  const changed = readPlan(root, dependent);
  expect(changed.contents).toContain("Uses demo:TSK-0, unlike demo:plan/service-extra");
  expect(changed.approval?.contents).toBe(changed.contents);
  expect(changed.approval?.at).toBe(dependentApproval.approval?.at);
  expect(changed.approval?.current).toBe(true);
  expect(readPlan(root, unrelated).draft).toBe(true);
  expect(git(root, "show", "future:plans/demo/consumer/plan.md")).toContain("demo:TSK-0");
  expect(git(root, "ls-tree", "-r", "--name-only", "future")).not.toContain("other/plan.md");
  expect(git(root, "rev-parse", "future^")).toBe(before);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "write-tree")).toBe(index);
});
test("a changed first source plan preserves its saved version and claim for reconciliation", async () => {
  const root = fixture();
  approved(root);
  await startPlan(root, service.reference);
  const file = join(root, "workbench/tasks/TSK-00.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("Install a service", "Implement a different service"));
  git(root, "add", "workbench");
  git(root, "commit", "-qm", "Change the approved plan");
  expect(() => finishPlanTransfers(root)).toThrow(/differs from the transferred plan/);
  expect(readPlan(root, service).approval?.current).toBe(true);
  expect(readPlanOperations(root)).toHaveLength(1);
});

test("renaming a queued plan preserves approval, relationships, order, and recovery without checkpointing unrelated drafts", () => {
  const root = fixture(),
    renamed = planIdentity("demo", "background-service"),
    dependent = planIdentity("demo", "consumer");
  const original = approved(root),
    child = savePlanDraft(
      root,
      dependent,
      `---\nstatus: Planned\nparent: ${service.reference}\n---\n\n# Consumer\n\nUses ${service.reference} and ${service.reference}-extra.\n`,
    );
  expect(() => changeTaskQueue(root, { action: "add", references: [dependent.reference] })).toThrow(/approve/);
  approvePlanDraft(root, dependent, child.digest, true);
  const head = git(root, "rev-parse", "HEAD"),
    saved = git(root, "rev-parse", "future");
  expect(() => renamePlan(root, service, renamed, "0".repeat(64))).toThrow(/changed/);
  expect(() =>
    renamePlan(root, service, renamed, original.digest, {
      onApplied: () => {
        throw new Error("Interrupted queue update");
      },
    }),
  ).toThrow(/Interrupted queue/);
  const operation = readPlanOperations(root).find((entry) => entry.operation.kind === "rename");
  if (!operation) throw new Error("Missing rename recovery");
  git(root, "gc", "--prune=now");
  expect(resumePlanRename(root, operation.operation.id)).toBe(renamed.reference);
  const next = readPlan(root, renamed);
  expect(next.approval?.at).toBe(original.approval?.at);
  expect(next.approval?.current).toBe(true);
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual([renamed.reference, dependent.reference]);
  expect(readPlan(root, dependent).contents).toContain(`parent: ${renamed.reference}`);
  expect(readPlan(root, dependent).contents).toContain(`Uses ${renamed.reference} and ${service.reference}-extra`);
  expect(child.contents).toContain(service.reference);
  expect(readPlanOperations(root)).toEqual([]);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "rev-parse", "future")).toBe(saved);
});

test("draft-only transfers retire safely before planning storage is enabled and retain rewritten sibling context", async () => {
  const root = fixture(false),
    dependent = planIdentity("demo", "consumer");
  approved(root);
  savePlanDraft(root, dependent, `---\nstatus: Planned\n---\n\n# Consumer\n\nDepends on ${service.reference}.\n`);
  await startPlan(root, service.reference);
  git(root, "add", "workbench");
  git(root, "commit", "-qm", "Implement service");
  expect(finishPlanTransfers(root)).toEqual(["demo:TSK-0"]);
  expect(readPlanOperations(root)).toEqual([]);
  expect(readPlans(root).map((plan) => plan.reference)).toEqual([dependent.reference]);
  expect(readPlan(root, dependent).contents).toContain("Depends on demo:TSK-0");
  configurePlanning(root, { branch: "future", auto_prune: true });
  checkpointPlans(root);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(git(root, "ls-tree", "-r", "--name-only", "future")).toContain("plans/demo/consumer/plan.md");
  expect(git(root, "ls-tree", "-r", "--name-only", "future")).not.toContain("plans/demo/service/plan.md");
});

test("an unstaged handoff preserves Git executable intent when the filesystem does not track permission bits", async () => {
  const root = fixture();
  git(root, "config", "core.filemode", "false");
  approved(root);
  await startPlan(root, service.reference);
  expect(readTaskGraph(root).require("demo:TSK-0").approval?.current).toBe(true);
  git(root, "add", "workbench");
  git(root, "update-index", "--chmod=-x", "workbench/tasks/TSK-00/schema.bin");
  expect(readTaskGraph(root).require("demo:TSK-0").approval?.current).toBe(false);
  git(root, "commit", "-qm", "Commit with an unintended file mode");
  expect(() => finishPlanTransfers(root)).toThrow(/intended executable permission/);
  expect(readPlan(root, service).approval?.current).toBe(true);
  git(root, "update-index", "--chmod=+x", "workbench/tasks/TSK-00/schema.bin");
  expect(readTaskGraph(root).require("demo:TSK-0").approval?.current).toBe(true);
  git(root, "commit", "--amend", "--no-edit", "-q");
  expect(finishPlanTransfers(root)).toEqual(["demo:TSK-0"]);
  expect(readPlanOperations(root)).toEqual([]);
});

test("Added at survives saves, renaming, approval and task transfer without becoming execution order", async () => {
  const root = fixture(),
    added = "2026-11-10T12:34:56.000Z";
  const initial = savePlanDraft(
    root,
    service,
    `---\nstatus: Planned\nadded_at: ${added}\n---\n\n# Service\n\nUseful work.\n`,
  );
  const saved = savePlanDraft(root, service, initial.contents.replace(`added_at: ${added}\n`, ""), {
    expected: initial.digest,
  });
  expect(saved.document?.metadata.added_at).toBe(added);
  const accepted = approvePlanDraft(root, service, saved.digest, true),
    renamed = planIdentity("demo", "daemon");
  const moved = renamePlan(root, service, renamed, accepted.digest);
  expect(moved.document?.metadata.added_at).toBe(added);
  expect(moved.approval?.current).toBe(true);
  changeTaskQueue(root, { action: "add", references: [renamed.reference] });
  const reference = await startPlan(root, renamed.reference);
  const task = readTaskGraph(root).require(reference);
  expect(task.metadata.added_at).toBe(added);
  expect(task.approval?.current).toBe(true);
});
