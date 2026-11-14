import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { git, distribution } from "../../../fixtures/adoption.mjs";
import { webFixture } from "../../../fixtures/web.mjs";
import {
  configurePlanning,
  savePlanDraft,
  checkpointPlans,
  publishPlanDraftUpdates,
  approvePlanDraft,
} from "../../../../src/core/tasks/planning/planning-operations.ts";
import { planningSettings, readPlan, readPlans } from "../../../../src/core/tasks/planning/planning-store.ts";
import { planIdentity } from "../../../../src/core/tasks/planning/plan-model.ts";
import { checkPlanningPublication } from "../../../../src/core/tasks/planning/planning-publication.ts";
import { pruneEmptyPlanning } from "../../../../src/core/tasks/planning/planning-retention.ts";
import { planDeletion, deletePlan, cancelPlan } from "../../../../src/core/tasks/planning/plan-disposition.ts";
import { changeTaskQueue, readTaskQueue } from "../../../../src/core/tasks/task-queue.ts";
import { gitRevision } from "../../../../src/core/git/refs.ts";
import { updatedReviewTree, writeReviewBlobs } from "../../../../src/core/git/git-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity = planIdentity("demo", "service"),
  contents = "---\nstatus: Planned\n---\n\n# Install a service\n\nKeep it optional.\n";
function fixture() {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = webFixture();
  roots.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/private-state"));
  return root;
}
function invoke(root: string, ...args: string[]) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

test("manual planning pushes use the exact destination, preserve source gates, and reject polluted checkpoint history", () => {
  const root = fixture(),
    remote = mkdtempSync(join(tmpdir(), "workbench-planning-remote-"));
  roots.push(remote);
  git(remote, "init", "--bare", "-q");
  const hooks = join(root, ".git/original-hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho ordinary-project-gate >&2\nexit 23\n");
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(root, "config", "core.hooksPath", hooks);
  git(root, "remote", "add", "backup", remote);
  configurePlanning(root, { branch: "future", remote: "backup", remote_branch: "plans", auto_prune: true });
  const savedContents = savePlanDraft(root, identity, contents).contents;
  checkpointPlans(root);
  const tip = git(root, "rev-parse", "future"),
    zero = "0".repeat(tip.length),
    updates = `refs/heads/future ${tip} refs/heads/plans ${zero}\n`;
  expect(checkPlanningPublication(root, updates, "backup", remote)).toEqual(["refs/heads/future"]);
  expect(() => checkPlanningPublication(root, updates, "alias", remote)).toThrow(/configured planning destination/);
  expect(() => checkPlanningPublication(root, updates, "backup", remote + "other")).toThrow(
    /configured planning destination/,
  );
  const push = invoke(root, "push", "backup", "future:plans");
  expect(push.status, push.stderr).toBe(0);
  expect(git(remote, "rev-parse", "refs/heads/plans")).toBe(tip);
  const ordinary = invoke(root, "push", "backup", "HEAD:main");
  expect(ordinary.status).not.toBe(0);
  expect(ordinary.stderr).toContain("ordinary-project-gate");
  const oid = writeReviewBlobs(root, [Buffer.from("application code")])[0];
  if (!oid) throw new Error("Missing fixture blob");
  const dirtyTree = updatedReviewTree(root, tip, [{ path: "application.ts", entry: { mode: "100644", oid } }]),
    dirty = git(root, "commit-tree", dirtyTree, "-p", tip, "-m", "Leak implementation"),
    cleaned = git(
      root,
      "commit-tree",
      git(root, "rev-parse", `${tip}^{tree}`),
      "-p",
      dirty,
      "-m",
      "Remove leaked file",
    );
  expect(() =>
    checkPlanningPublication(root, `refs/heads/future ${cleaned} refs/heads/plans ${tip}\n`, "backup", remote),
  ).toThrow(/unexpected file/);
  const source = git(root, "rev-parse", "HEAD");
  expect(() =>
    checkPlanningPublication(root, `refs/heads/main ${source} refs/heads/plans ${tip}\n`, "backup", remote),
  ).toThrow(/planning history lacks|Planning history lacks/);
  const checkout = join(root, ".git/planning-checkout");
  git(root, "worktree", "add", "-q", checkout, "future");
  const fromPlanning = invoke(checkout, "push", "backup", "future:plans");
  expect(fromPlanning.status, fromPlanning.stderr).toBe(0);
  expect(readFileSync(join(checkout, "plans/demo/service/plan.md"), "utf8")).toBe(savedContents);
  const shown = spawnSync(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "task", "plan", "show", identity.reference, "--json"],
    {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: checkout, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    },
  );
  expect(shown.status, shown.stderr).toBe(0);
  expect(JSON.parse(shown.stdout) as { contents: string }).toMatchObject({ contents: savedContents });
  git(root, "worktree", "remove", "--force", checkout);
});

test("empty planning retention protects local queues and unpushed saves, then recreates independent history on demand", () => {
  const root = fixture(),
    remote = join(root, ".git/backup.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  git(root, "remote", "add", "backup", remote);
  configurePlanning(root, { branch: "future", remote: "backup", remote_branch: "plans", auto_prune: true });
  savePlanDraft(root, identity, contents);
  checkpointPlans(root);
  const saved = readPlan(root, identity);
  publishPlanDraftUpdates(root, [{ identity, expected: saved.digest }]);
  checkpointPlans(root);
  const empty = git(root, "rev-parse", "future");
  expect(pruneEmptyPlanning(root)).toBe(false);
  git(root, "push", "backup", "future:plans");
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Approved\n---\n\n# TSK-0: Work\n");
  changeTaskQueue(root, { action: "add", references: ["demo:TSK-0"] });
  expect(pruneEmptyPlanning(root)).toBe(false);
  changeTaskQueue(root, { action: "remove", reference: "demo:TSK-0" });
  expect(pruneEmptyPlanning(root)).toBe(true);
  expect(gitRevision(root, "refs/heads/future")).toBeUndefined();
  savePlanDraft(root, identity, contents);
  const recreated = checkpointPlans(root);
  expect(recreated).not.toBe(empty);
  expect(git(root, "rev-list", "--parents", "-n", "1", "future")).toBe(recreated);
  expect(planningSettings(root).branch).toBe("future");
  git(root, "update-ref", "-d", "refs/heads/future");
  expect(readPlans(root)).toEqual([]);
  const fresh = savePlanDraft(root, identity, contents);
  expect(fresh.draft).toBe(true);
  checkpointPlans(root);
  expect(readPlan(root, identity).contents).toBe(fresh.contents);
  git(root, "commit", "--allow-empty", "-qm", "Local checkpoint\n\nWorkbench-Provisional: true");
  const blocked = invoke(root, "push", "backup", "HEAD:application");
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toContain("provisional commits");
});

test("cancel and delete retain reasons, reject stale previews and incoming relationships, and preserve explicit recovery", () => {
  const root = fixture();
  configurePlanning(root, { branch: "future", auto_prune: false });
  savePlanDraft(root, identity, contents);
  const child = planIdentity("demo", "child");
  savePlanDraft(root, child, contents.replace("status: Planned", "status: Planned\nparent: demo:plan/service"));
  checkpointPlans(root);
  expect(planDeletion(root, identity).problems.join(" ")).toContain("incoming relationships");
  const prior = approvePlanDraft(root, child, readPlan(root, child).digest, true),
    canceled = cancelPlan(root, child, prior.digest, "The parent no longer needs it.");
  expect(canceled.document?.metadata.status).toBe("Canceled");
  expect(canceled.contents).toContain("The parent no longer needs it.");
  expect(readTaskQueue(root).entries).toEqual([]);
  const proposal = planDeletion(root, child);
  savePlanDraft(root, child, canceled.contents + "\nRetain context.\n", { expected: canceled.digest });
  expect(() => deletePlan(root, child, proposal.digest)).toThrow(/changed/);
  const recovery = deletePlan(root, child, planDeletion(root, child).digest);
  expect(gitRevision(root, recovery)).toBeDefined();
  expect(readPlans(root).map((view) => view.reference)).toEqual([identity.reference]);
  deletePlan(root, identity, planDeletion(root, identity).digest);
  checkpointPlans(root);
  expect(pruneEmptyPlanning(root)).toBe(false);
  expect(gitRevision(root, "refs/heads/future")).toBeDefined();
});
