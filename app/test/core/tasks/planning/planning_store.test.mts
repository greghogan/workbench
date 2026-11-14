import { gitRevision } from "../../../../src/core/git/refs.ts";
import { changeTaskQueue, readTaskQueue } from "../../../../src/core/tasks/task-queue.ts";
import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, distribution } from "../../../fixtures/adoption.mjs";
import {
  gitBytes,
  readGitObjects,
  updatedReviewTree,
  writeReviewBlobs,
} from "../../../../src/core/git/git-snapshot.ts";
import { integrateBranch } from "../../../../src/core/git/branch-integration.ts";
import { planIdentity, planDraftRef } from "../../../../src/core/tasks/planning/plan-model.ts";
import { readPlan, readPlans, planningSettings } from "../../../../src/core/tasks/planning/planning-store.ts";
import {
  savePlanDraft,
  publishPlanDraftUpdates,
  configurePlanning,
  checkpointPlans,
  approvePlanDraft,
  resolvePlanDraft,
  recoverPlanningCheckpoint,
  planningOperation,
} from "../../../../src/core/tasks/planning/planning-operations.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const first = planIdentity("demo", "service"),
  second = planIdentity("demo", "artifacts");
const plan = (text: string) => `---\nstatus: Planned\n---\n\n# Service installation\n\n${text}\n`;
function fixture() {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = mkdtempSync(join(tmpdir(), "workbench-planning-"));
  roots.push(root);
  git(root, "init", "-qb", "main");
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  writeFileSync(join(root, "application.txt"), "Application source.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  return root;
}
function enable(root: string) {
  configurePlanning(root, { branch: "future", auto_prune: true });
}
function advancePlan(root: string, contents: string) {
  const before = git(root, "rev-parse", "future"),
    blob = writeReviewBlobs(root, [Buffer.from(contents)])[0];
  if (!blob) throw new Error("Missing fixture object");
  const tree = updatedReviewTree(root, before, [
    { path: "plans/demo/service/plan.md", entry: { mode: "100644", oid: blob } },
  ]);
  const after = git(root, "commit-tree", tree, "-p", before, "-m", "Edit plan directly");
  git(root, "update-ref", "refs/heads/future", after, before);
  return after;
}

test("draft saves preserve incomplete work and exact assets without creating commits or changing the source checkout", () => {
  const root = fixture(),
    head = git(root, "rev-parse", "HEAD"),
    bytes = Buffer.from([0, 1, 255, 10]);
  const initial = savePlanDraft(root, first, plan("Install a user service."), {
    files: new Map([["evidence/run.sh", { contents: bytes, executable: true }]]),
  });
  const changed = savePlanDraft(root, first, "An unfinished draft", { expected: initial.digest });
  expect(readPlan(root, first).contents).toBe("An unfinished draft");
  expect(changed.problem).toMatch(/frontmatter/);
  expect(readPlans(root).map((item) => item.reference)).toEqual([first.reference]);
  const entry = changed.entries.get("files/evidence/run.sh");
  expect(entry?.mode).toBe("100755");
  expect(readGitObjects(root, [entry?.oid ?? ""]).get(entry?.oid ?? "")).toEqual(bytes);
  expect(() => checkpointPlans(root)).toThrow(/Enable planning/);
  expect(git(root, "rev-list", "--all", "--count")).toBe("1");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "status", "--porcelain=v1")).toBe("");
  expect(planningSettings(root).branch).toBeUndefined();
});

test("explicit grouped checkpoints retain independent save history and preserve unrelated staged source work", () => {
  const root = fixture(),
    backup = join(root, ".git/backup.git");
  git(root, "init", "--bare", "--quiet", backup);
  git(root, "remote", "add", "backup", backup);
  configurePlanning(root, { branch: "future", remote: "backup", remote_branch: "plans", auto_prune: true });
  const one = savePlanDraft(root, first, plan("Install a service."));
  savePlanDraft(root, second, plan("Package artifacts."));
  writeFileSync(join(root, "application.txt"), "Unrelated staged work.\n");
  git(root, "add", "application.txt");
  writeFileSync(join(root, "notes.txt"), "Untracked developer notes.\n");
  const index = git(root, "write-tree"),
    source = git(root, "rev-parse", "HEAD"),
    checkpoint = checkpointPlans(root);
  if (!checkpoint) throw new Error("Expected a grouped checkpoint");
  expect(git(root, "rev-list", "--parents", "-n", "1", "future")).toBe(checkpoint);
  expect(readPlans(root)).toHaveLength(2);
  expect(gitRevision(root, planDraftRef(first))).toBeUndefined();
  expect(git(root, "write-tree")).toBe(index);
  expect(git(root, "rev-parse", "HEAD")).toBe(source);
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("Untracked developer notes.\n");
  const saved = readPlan(root, first);
  expect(saved.draft).toBe(false);
  const next = savePlanDraft(root, first, plan("Install and supervise the service."), { expected: saved.digest });
  expect(() => savePlanDraft(root, first, plan("Stale overwrite."), { expected: one.digest })).toThrow(/changed/);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(() => checkpointPlans(root, [first, first])).toThrow(/only once/);
  const latest = checkpointPlans(root, [first]);
  expect(latest).not.toBe(checkpoint);
  expect(git(root, "rev-list", "--count", "future")).toBe("2");
  expect(git(root, "show", `${checkpoint}:plans/demo/service/plan.md`)).toContain("Install a service.");
  expect(readPlan(root, first).contents).toBe(next.contents);
  expect(git(backup, "for-each-ref", "--format=%(refname)")).toBe("");
  expect(checkpointPlans(root)).toBe(latest);
  expect(git(root, "rev-list", "--count", "future")).toBe("2");
});

test("approval survives edits and Git collection before any planning commit, and enabled approvals checkpoint once", () => {
  const root = fixture(),
    original = savePlanDraft(root, first, plan("Install a service."), {
      files: new Map([["example.bin", { contents: Buffer.from([0, 255, 11]) }]]),
    });
  expect(() => approvePlanDraft(root, first, original.digest, false)).toThrow(/Human confirmation/);
  const approved = approvePlanDraft(root, first, original.digest, true),
    at = approved.approval?.at;
  expect(approved.approval?.current).toBe(true);
  expect(git(root, "rev-list", "--all", "--count")).toBe("1");
  const edited = savePlanDraft(root, first, approved.contents.replace("Install a service.", "Install two services."), {
    expected: approved.digest,
    files: new Map([["example.bin", { contents: Buffer.from([22]) }]]),
  });
  git(root, "gc", "--prune=now");
  const restored = readPlan(root, first);
  expect(restored.approval?.contents).toBe(approved.contents);
  expect(restored.approval?.at).toBe(at);
  expect(restored.approval?.current).toBe(false);
  const oldFile = restored.approval?.entries.get("files/example.bin");
  expect(readGitObjects(root, [oldFile?.oid ?? ""]).get(oldFile?.oid ?? "")).toEqual(Buffer.from([0, 255, 11]));
  enable(root);
  const confirmed = approvePlanDraft(root, first, edited.digest, true);
  expect(confirmed.approval?.current).toBe(true);
  expect(confirmed.draft).toBe(false);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(approvePlanDraft(root, first, confirmed.digest, true).approval?.at).toBe(confirmed.approval?.at);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
});

test("approval appends work in approval order while reapproval preserves its execution position", () => {
  const root = fixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/private-state"));
  const one = savePlanDraft(root, first, plan("Earlier draft.")),
    two = savePlanDraft(root, second, plan("Later draft."));
  expect(() => changeTaskQueue(root, { action: "add", references: [first.reference] })).toThrow(/approve/);
  expect(readTaskQueue(root).entries).toEqual([]);
  approvePlanDraft(root, second, two.digest, true);
  approvePlanDraft(root, first, one.digest, true);
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual([second.reference, first.reference]);
  const current = readPlan(root, second),
    changed = savePlanDraft(root, second, current.contents.replace("Later draft.", "Revised plan."), {
      expected: current.digest,
    });
  approvePlanDraft(root, second, changed.digest, true);
  expect(readTaskQueue(root).entries.map((entry) => [entry.reference, entry.state])).toEqual([
    [second.reference, "Queued"],
    [first.reference, "Queued"],
  ]);
});

test("concurrent saved and draft edits require explicit resolution and retain both histories", () => {
  const root = fixture();
  enable(root);
  savePlanDraft(root, first, plan("Original scope."));
  checkpointPlans(root);
  const initial = readPlan(root, first);
  savePlanDraft(root, first, plan("Local extension."), { expected: initial.digest });
  const concurrent = advancePlan(root, plan("Other extension.")),
    conflict = readPlan(root, first);
  expect(conflict.conflict).toBe(true);
  expect(() => checkpointPlans(root)).toThrow(/concurrent/);
  expect(git(root, "show", `${concurrent}:plans/demo/service/plan.md`)).toContain("Other extension.");
  const resolved = resolvePlanDraft(root, first, plan("Both extensions."), conflict.digest);
  expect(resolved.conflict).toBe(false);
  checkpointPlans(root);
  expect(readPlan(root, first).contents).toContain("Both extensions.");
  expect(git(root, "show", `${concurrent}:plans/demo/service/plan.md`)).toContain("Other extension.");
});

test("an interrupted checkpoint retains its prepared commit through GC and resumes exactly once", () => {
  const root = fixture();
  enable(root);
  savePlanDraft(root, first, plan("A recoverable plan."));
  expect(() =>
    checkpointPlans(root, undefined, {
      onRecorded: () => {
        throw new Error("Interrupted checkpoint");
      },
    }),
  ).toThrow(/Interrupted/);
  const pending = planningOperation(root);
  expect(pending?.completed).toBe(false);
  expect(() => integrateBranch(root, "rebase", { target: "main" })).toThrow(/planning operation requires recovery/);
  expect(() => savePlanDraft(root, second, plan("Concurrent work."))).toThrow(/Recover/);
  git(root, "gc", "--prune=now");
  expect(recoverPlanningCheckpoint(root)).toBe(pending?.after);
  expect(recoverPlanningCheckpoint(root)).toBe(pending?.after);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(readPlan(root, first).draft).toBe(false);
  expect(git(root, "for-each-ref", "--format=%(refname)", "refs/workbench/plan-checkpoints/")).toBe("");
  expect(git(root, "status", "--porcelain=v1")).toBe("");
});

test("checkpointing updates a clean linked planning checkout and preserves intervening editor changes", () => {
  const root = fixture();
  enable(root);
  savePlanDraft(root, first, plan("First saved version."));
  checkpointPlans(root);
  const checkout = join(root, ".git/planning-view");
  git(root, "worktree", "add", "--quiet", checkout, "future");
  const editorPath = join(checkout, "plans/demo/service/plan.md");
  writeFileSync(editorPath, plan("A direct editor save."));
  expect(() => checkpointPlans(root)).toThrow(/uncommitted editor changes/);
  expect(readFileSync(editorPath, "utf8")).toContain("direct editor save");
  git(checkout, "add", "plans/demo/service/plan.md");
  git(checkout, "commit", "-qm", "Checkpoint editor changes");
  expect(readPlan(root, first).contents).toContain("direct editor save");
  const current = readPlan(root, first);
  savePlanDraft(root, first, plan("Second saved version."), { expected: current.digest });
  checkpointPlans(root);
  const path = join(checkout, "plans/demo/service/plan.md"),
    secondVersion = readFileSync(path, "utf8");
  expect(secondVersion).toContain("Second saved version.");
  expect(git(checkout, "status", "--porcelain=v1")).toBe("");
  const next = readPlan(root, first);
  savePlanDraft(root, first, plan("Third saved version."), { expected: next.digest });
  expect(() =>
    checkpointPlans(root, undefined, {
      onRecorded: () => {
        writeFileSync(path, plan("Intervening editor work."));
      },
    }),
  ).toThrow(/File changed/);
  expect(readFileSync(path, "utf8")).toContain("Intervening editor work.");
  expect(() => recoverPlanningCheckpoint(root)).toThrow(/File changed/);
  writeFileSync(path, secondVersion);
  recoverPlanningCheckpoint(root);
  expect(readFileSync(path, "utf8")).toContain("Third saved version.");
  expect(git(checkout, "status", "--porcelain=v1")).toBe("");
});

test("invalid destinations and supporting paths cannot activate planning or publish outside its record tree", () => {
  const root = fixture();
  git(root, "branch", "application", "main");
  expect(() => {
    configurePlanning(root, { branch: "main", auto_prune: true });
  }).toThrow(/separate/);
  expect(() => {
    configurePlanning(root, { branch: "application", auto_prune: true });
  }).toThrow(/scope|planning/i);
  expect(planningSettings(root).branch).toBeUndefined();
  expect(() =>
    savePlanDraft(root, first, plan("Unsafe attachment."), {
      files: new Map([["../outside", { contents: Buffer.from("unsafe") }]]),
    }),
  ).toThrow(/path/);
  expect(readPlans(root)).toEqual([]);
  expect(gitBytes(root, ["for-each-ref", "--format=%(refname)", "refs/workbench/"]).length).toBe(0);
});

test("plans for a removed scope remain available while another scope checkpoints new work", () => {
  const root = fixture(),
    component = planIdentity("component", "future-service");
  mkdirSync(join(root, "component"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[project]]\nid="component"\npath="component"\n',
  );
  enable(root);
  savePlanDraft(root, component, plan("Keep this component's future work."));
  checkpointPlans(root);
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  savePlanDraft(root, first, plan("New root work."));
  checkpointPlans(root);
  expect(readPlan(root, component).contents).toContain("component's future work");
  expect(readPlans(root)).toHaveLength(2);
});

test("identity changes stay grouped through a selected checkpoint and interrupted cleanup without publishing unrelated drafts", () => {
  const root = fixture(),
    renamed = planIdentity("demo", "daemon");
  enable(root);
  const draft = savePlanDraft(root, first, plan("The retained service plan."));
  approvePlanDraft(root, first, draft.digest, true);
  const initial = readPlan(root, first),
    before = git(root, "rev-parse", "future");
  savePlanDraft(root, second, plan("Leave this draft uncommitted."));
  publishPlanDraftUpdates(root, [
    { identity: first, expected: initial.digest },
    { identity: renamed, entries: initial.entries },
  ]);
  expect(readPlans(root).map((view) => view.name)).toEqual(["artifacts", "daemon"]);
  expect(readPlan(root, renamed).approval?.at).toBe(initial.approval?.at);
  expect(git(root, "rev-parse", "future")).toBe(before);
  expect(() =>
    checkpointPlans(root, [renamed], {
      onRecorded: () => {
        throw new Error("Interrupted grouped rename");
      },
    }),
  ).toThrow(/Interrupted grouped/);
  git(root, "gc", "--prune=now");
  recoverPlanningCheckpoint(root);
  const paths = git(root, "ls-tree", "-r", "--name-only", "future");
  expect(paths).toContain("plans/demo/daemon/plan.md");
  expect(paths).not.toContain("plans/demo/service/");
  expect(paths).not.toContain("plans/demo/artifacts/");
  expect(readPlan(root, second).draft).toBe(true);
  expect(readPlan(root, renamed).draft).toBe(false);
  expect(git(root, "show", `${before}:plans/demo/service/plan.md`)).toContain("retained service plan");
  expect(
    git(
      root,
      "for-each-ref",
      "--format=%(refname)",
      "refs/workbench/plan-removals",
      "refs/workbench/plan-draft-groups",
    ),
  ).toBe("");
});
