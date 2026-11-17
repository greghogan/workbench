import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerAgentReviewCommands } from "../../../src/cli/agent-review.ts";
import { afterEach, test, expect, vi } from "vitest";
import { gitBytes, workingReviewTree } from "../../../src/core/git/git-snapshot.ts";
import {
  AgentReviewKind,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
  checkAgentCommit,
  checkAgentPush,
  finishAgentCommit,
} from "../../../src/core/review/agent-review.ts";
import { authorizeProjectReview, changeTaskStatus } from "../../../src/core/tasks/task-service.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { changeTaskQueue, readTaskQueue, taskQueuePath } from "../../../src/core/tasks/task-queue.ts";
import {
  applyTaskDecisionChange,
  prepareTaskDecisionChange,
  readTaskDecisions,
  taskDecisionPath,
} from "../../../src/core/tasks/task-decisions.ts";
import { changeExperimentStatus } from "../../../src/core/experiments/experiment-workflow.ts";
import { requiredExperimentProtocol } from "../../../src/core/records/record-content.ts";
import { syncMaps } from "../../../src/core/records/maps.ts";
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-agent-review-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[review]\nchanges=true\ntasks=true\ntask_approvals=true\n",
  );
  writeFileSync(join(root, "workbench/CHARTER.md"), "# Charter\n\nTest-owned charter.\n");
  writeFileSync(join(root, "source.ts"), "export const value=1;\n");
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  const review = (
    kind = AgentReviewKind.Changes,
    options: { base?: string; amend?: boolean; tasks?: string[] } = {},
  ) => {
    const proposed = proposedAgentReview(root, kind, { ...options, staged: true });
    recordAgentReview(
      root,
      {
        ...proposed,
        summary: "Reviewed behavior and interactions; no unresolved findings",
        verification: "Focused regression tests passed",
      },
      reviewIdentity(proposed),
      true,
    );
    return proposed;
  };
  return { root, git, base, review };
}
test("change receipts bind the complete staged tree while preserving unstaged work", () => {
  const f = fixture();
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "source.ts"]);
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/Change review is required/);
  const reviewed = f.review();
  checkAgentCommit(f.root);
  writeFileSync(join(f.root, "source.ts"), "export const value=3;\n");
  checkAgentCommit(f.root);
  expect(f.git(["write-tree"])).toBe(reviewed.tree);
  f.git(["add", "source.ts"]);
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/Change review is required/);
  expect(readFileSync(join(f.root, "source.ts"), "utf8")).toBe("export const value=3;\n");
  expect(() => {
    recordAgentReview(f.root, { ...reviewed, summary: "old", verification: "old" }, reviewIdentity(reviewed), true);
  }).toThrow(/Review contents changed/);
});

test("staged review preserves partial staging and another writer's index lock", () => {
  const f = fixture();
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "source.ts"]);
  const expected = f.git(["write-tree"]);
  writeFileSync(join(f.root, "source.ts"), "export const value=3;\n");
  writeFileSync(join(f.root, "future.ts"), "not staged\n");
  f.git(["add", "--intent-to-add", "future.ts"]);
  const indexPath = join(f.root, ".git/index"),
    index = readFileSync(indexPath),
    lockPath = `${indexPath}.lock`,
    owner = "another index writer\n";
  writeFileSync(lockPath, owner, { flag: "wx" });
  expect(proposedAgentReview(f.root, AgentReviewKind.Task, { staged: true, base: f.base }).tree).toBe(expected);
  expect(f.review().tree).toBe(expected);
  checkAgentCommit(f.root);
  expect(readFileSync(indexPath)).toEqual(index);
  expect(readFileSync(lockPath, "utf8")).toBe(owner);
  expect(readFileSync(join(f.root, "source.ts"), "utf8")).toBe("export const value=3;\n");
  expect(readFileSync(join(f.root, "future.ts"), "utf8")).toBe("not staged\n");
});

test("reviewing retained history preserves current staged and working review evidence", () => {
  const f = fixture();
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "source.ts"]);
  f.review();
  writeFileSync(join(f.root, "source.ts"), "export const value=3;\n");
  const working = proposedAgentReview(f.root, AgentReviewKind.Changes);
  recordAgentReview(
    f.root,
    { ...working, summary: "Reviewed current working changes", verification: "Fixture assertions" },
    reviewIdentity(working),
  );
  const historical = proposedAgentReview(f.root, AgentReviewKind.Task, { commit: f.base, base: f.base });
  recordAgentReview(
    f.root,
    { ...historical, summary: "Reviewed retained history", verification: "Fixture assertions" },
    reviewIdentity(historical),
    false,
    f.base,
  );
  checkAgentCommit(f.root);
  checkAgentCommit(f.root, workingReviewTree(f.root));
  expect(f.git(["show", ":source.ts"])).toBe("export const value=2;");
  expect(readFileSync(join(f.root, "source.ts"), "utf8")).toBe("export const value=3;\n");
});

test("snapshot gates allow experiment execution and refinement without a protocol approval receipt", () => {
  const f = fixture(),
    path = join(f.root, "workbench/experiments/EXP-00.md");
  mkdirSync(join(f.root, "workbench/experiments"));
  const protocol =
    "---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: Compare lookup strategies\n\n" +
    requiredExperimentProtocol.map((heading) => `## ${heading}\n\nControlled comparison.\n`).join("\n");
  writeFileSync(path, protocol);
  changeExperimentStatus(f.root, "demo:EXP-0", "Running");
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Record an experiment in progress"]);
  writeFileSync(path, readFileSync(path, "utf8") + "\n## Evidence\n\nMeasured results.\n");
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  writeFileSync(path, readFileSync(path, "utf8").replace("Controlled comparison.", "Different workload."));
  // The unstaged protocol edit cannot invalidate evidence for the staged protocol.
  checkAgentCommit(f.root);
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
});
test("push review covers outgoing work after rebasing without collaborators' local receipts", () => {
  const f = fixture();
  // Simulate fetching a collaborator's commit: their receipt never exists in this clone.
  writeFileSync(join(f.root, "collaborator.ts"), "export const shared=1;\n");
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "collaborator"]);
  const upstream = f.git(["rev-parse", "HEAD"]);
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "local work"]);
  finishAgentCommit(f.root);
  expect(() => {
    checkAgentPush(f.root, "HEAD", upstream);
  }).toThrow(/Accumulated work review/);
  f.review(AgentReviewKind.Task, { base: upstream });
  checkAgentPush(f.root, "HEAD", upstream);
  // Retry preserves evidence; updating the destination baseline invalidates it.
  checkAgentPush(f.root, "HEAD", upstream);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated work review/);
});
test("pending receipts replace superseded reviews and successful commits release change evidence", () => {
  const f = fixture();
  for (let index = 2; index <= 6; index++) {
    writeFileSync(join(f.root, "source.ts"), `export const value=${String(index)};\n`);
    f.git(["add", "."]);
    f.review();
    f.review(AgentReviewKind.Task, { base: f.base });
  }
  const stored = () =>
    JSON.parse(readFileSync(join(f.root, ".git/workbench/agent-reviews.json"), "utf8")) as {
      reviews: { kind: string }[];
    };
  expect(
    stored()
      .reviews.map((entry) => entry.kind)
      .sort(),
  ).toEqual(["changes", "task"]);
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "reviewed work"]);
  const cleanup = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../../../../bin/workbench.mjs"), "review", "finish-commit"],
    {
      cwd: f.root,
      env: process.env,
      encoding: "utf8",
    },
  );
  expect(cleanup.status, cleanup.stdout + cleanup.stderr).toBe(0);
  expect(stored().reviews.map((entry) => entry.kind)).toEqual(["task"]);
  checkAgentPush(f.root, "HEAD", f.base);
  // A later outgoing push confirms that the prior snapshot reached the destination.
  const published = f.git(["rev-parse", "HEAD"]);
  writeFileSync(join(f.root, "source.ts"), "export const value=7;\n");
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "next work"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", published);
  }).toThrow(/Accumulated work review/);
  expect(stored().reviews).toEqual([]);
});
test("working review includes new files without modifying the user's index", () => {
  const f = fixture();
  const index = f.git(["write-tree"]);
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  writeFileSync(join(f.root, "new.ts"), "export const added=true;\n");
  const proposed = proposedAgentReview(f.root, AgentReviewKind.Changes);
  expect(proposed.tree).not.toBe(index);
  recordAgentReview(
    f.root,
    { ...proposed, summary: "Reviewed all current files", verification: "Checks passed" },
    reviewIdentity(proposed),
  );
  expect(f.git(["write-tree"])).toBe(index);
  f.git(["add", "."]);
  checkAgentCommit(f.root);
});
test("disabling review requirements is itself reviewed under the previous policy", () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "workbench/config.toml"),
    "schema_version=1\n[review]\nchanges=false\ntasks=false\ntask_approvals=false\n",
  );
  f.git(["add", "."]);
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/Change review/);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "unreviewed policy removal"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated work review/);
  f.review(AgentReviewKind.Task, { base: f.base });
  checkAgentPush(f.root, "HEAD", f.base);
});
test("human task decisions gate publication while allowing implementation commits before acceptance", () => {
  const f = fixture();
  const path = join(f.root, "workbench/tasks/TSK-00.md");
  writeFileSync(
    path,
    "---\nstatus: Planned\n---\n\n# TSK-0: Deliver behavior\n\n## Overview\n\nA precise outcome.\n\n## Details\n\n- [x] Verified.\n",
  );
  expect(() => {
    changeTaskStatus(f.root, "TSK-0", "Approved");
  }).toThrow(/Human confirmation/);
  changeTaskStatus(f.root, "TSK-0", "Approved", undefined, true);
  changeTaskQueue(f.root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(f.root, { action: "start", reference: "TSK-0" });
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "implementation"]);
  f.review(AgentReviewKind.Task, { base: f.base });
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/human acceptance/i);
  changeTaskQueue(f.root, { action: "implemented", reference: "TSK-0", detail: "Tests passed" });
  const before = f.git(["write-tree"]);
  changeTaskStatus(f.root, "TSK-0", "Accepted", undefined, true);
  expect(f.git(["write-tree"])).toBe(before);
  expect(readTaskDecisions(f.root).find((decision) => decision.status === "Accepted")?.outcome).toBe(
    readTaskGraph(f.root).require("demo:TSK-0").reviewDigest,
  );
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.review(AgentReviewKind.Task, { base: f.base });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "accepted outcome"]);
  checkAgentPush(f.root, "HEAD", f.base);
  writeFileSync(join(f.root, "source.ts"), "export const value=3;\n");
  f.git(["add", "."]);
  f.review();
  f.review(AgentReviewKind.Task, { base: f.base });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "unrelated later work"]);
  checkAgentPush(f.root, "HEAD", f.base);
  writeFileSync(
    path,
    readFileSync(path, "utf8") + "\n## Implementation account\n\nFurther changes to the delivered outcome.\n",
  );
  f.git(["add", "."]);
  f.review();
  f.review(AgentReviewKind.Task, { base: f.base });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "changed outcome"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/acceptance does not cover/);
});

test("a squash preserves reviewed outcomes and requires fresh agent review of the replacement tree", () => {
  const f = fixture(),
    path = "workbench/tasks/TSK-00.md",
    sidecar = "workbench/tasks/TSK-00/results.txt";
  mkdirSync(join(f.root, "workbench/tasks/TSK-00"));
  writeFileSync(join(f.root, sidecar), "Observed the expected result.\n");
  writeFileSync(join(f.root, path), "---\nstatus: Planned\n---\n\n# TSK-0: Verify the result\n");
  changeTaskStatus(f.root, "TSK-0", "Approved", undefined, true);
  changeTaskQueue(f.root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(f.root, { action: "implemented", reference: "TSK-0", detail: "Verified behavior." });
  changeTaskStatus(f.root, "TSK-0", "Accepted", undefined, true);
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Accepted result"]);
  const tree = f.git(["rev-parse", "HEAD^{tree}"]);
  f.review(AgentReviewKind.Task, { base: f.base });
  checkAgentPush(f.root, "HEAD", f.base);

  // Model a receipt issued before outcome digests were stored directly.
  const prior = prepareTaskDecisionChange(f.root, "demo:TSK-0", (decisions) =>
    decisions.map((decision) => {
      if (decision.status !== "Accepted") return decision;
      delete decision.outcome;
      return { ...decision, tree };
    }),
  );
  applyTaskDecisionChange(f.root, prior);
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "source.ts"]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--no-edit"]);
  expect(f.git(["log", "--format=%T"]).split("\n")).not.toContain(tree);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated work review is required/);
  f.review(AgentReviewKind.Task, { base: f.base });
  checkAgentPush(f.root, "HEAD", f.base);
  expect(readTaskDecisions(f.root).find((decision) => decision.status === "Accepted")?.tree).toBe(tree);

  // Supporting material is part of the human decision even when the Markdown record is unchanged.
  f.git(["update-index", "--chmod=+x", sidecar]);
  f.review();
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/acceptance does not cover.*supporting files/);
  f.review(AgentReviewKind.Task, { base: f.base });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--no-edit"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/acceptance does not cover.*supporting files/);
});

test("a developer-requested review can be committed within its scope before the developer accepts its outcome", () => {
  const f = fixture(),
    path = join(f.root, "workbench/tasks/TSK-00.md");
  const plan = "---\nstatus: Planned\n---\n\n# TSK-0: Review ownership\n\n## Review summary\n\nAudit note ownership.\n";
  writeFileSync(path, plan);
  const task = readTaskGraph(f.root).require("demo:TSK-0");
  authorizeProjectReview(f.root, task.reference, task.reviewDigest ?? task.digest);
  expect(readTaskDecisions(f.root)).toMatchObject([{ source: "developer-requested-review", status: "Approved" }]);
  const result =
    readFileSync(path, "utf8") +
    "\n## Implementation account\n\nFixed one stale path. A larger proposal awaits discussion.\n";
  writeFileSync(path, result);
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Review ownership"]);
  f.review(AgentReviewKind.Task, { base: f.base });
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/human acceptance/i);
  writeFileSync(path, result.replace("Audit note ownership.", "Replace the storage design."));
  f.git(["add", "."]);
  f.review();
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/scope changed/);
});

test("delegated work can use uncommitted project approval without inheriting execution state or accepting other source", () => {
  const f = fixture(),
    task = "workbench/tasks/TSK-00.md";
  writeFileSync(join(f.root, task), "---\nstatus: Planned\n---\n\n# TSK-0: Delegated work\n\n- [x] Verify behavior.\n");
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "planned work"]);
  const baseline = f.git(["rev-parse", "HEAD"]),
    staged = f.git(["write-tree"]);
  changeTaskStatus(f.root, "TSK-0", "Approved", undefined, true);
  expect(f.git(["write-tree"])).toBe(staged);
  expect(readTaskQueue(f.root).entries.map((entry) => [entry.reference, entry.state])).toEqual([
    ["demo:TSK-0", "Queued"],
  ]);
  changeTaskQueue(f.root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(f.root, { action: "start", reference: "TSK-0" });
  const checkout = mkdtempSync(join(tmpdir(), "workbench-delegated-"));
  temporary.unshift(checkout);
  f.git(["worktree", "add", "--detach", checkout, baseline]);
  writeFileSync(join(checkout, task), readFileSync(join(f.root, task)));
  writeFileSync(join(checkout, "source.ts"), "export const value=2;\n");
  const command = (args: string[]) => gitBytes(checkout, args).toString().trim();
  const review = (kind = AgentReviewKind.Changes) => {
    const proposed = proposedAgentReview(checkout, kind, {
      staged: true,
      ...(kind === AgentReviewKind.Task ? { base: baseline } : {}),
    });
    recordAgentReview(
      checkout,
      { ...proposed, summary: "Reviewed delegated work", verification: "Behavior verified" },
      reviewIdentity(proposed),
      true,
    );
  };
  expect(taskDecisionPath(checkout)).toBe(taskDecisionPath(f.root));
  expect(existsSync(taskQueuePath(checkout))).toBe(false);
  command(["add", "."]);
  review();
  checkAgentCommit(checkout);

  changeTaskQueue(f.root, { action: "implemented", reference: "TSK-0", detail: "Verified the parent checkout" });
  changeTaskStatus(f.root, "TSK-0", "Accepted", undefined, true);
  writeFileSync(
    join(checkout, task),
    readFileSync(join(f.root, task), "utf8") + "\n## Implementation account\n\nDelivered a different result.\n",
  );
  syncMaps(checkout);
  command(["add", "."]);
  review();
  expect(() => {
    checkAgentCommit(checkout);
  }).toThrow(/acceptance does not cover/);
  command(["-c", "core.hooksPath=/dev/null", "commit", "-m", "delegated implementation"]);
  review(AgentReviewKind.Task);
  expect(() => {
    checkAgentPush(checkout, "HEAD", baseline);
  }).toThrow(/acceptance does not cover/);
  changeTaskStatus(checkout, "TSK-0", "Accepted", undefined, true);
  checkAgentPush(checkout, "HEAD", baseline);
  expect(existsSync(taskQueuePath(checkout))).toBe(false);

  // Accepting the delegated outcome preserves the parent's previously accepted version.
  f.git(["add", "."]);
  f.review();
  checkAgentCommit(f.root);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "parent implementation"]);
  f.review(AgentReviewKind.Task, { base: baseline });
  checkAgentPush(f.root, "HEAD", baseline);

  const other = fixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(f.root, ".git/local-state"));
  writeFileSync(
    join(other.root, task),
    readFileSync(join(f.root, task), "utf8").replace("status: Accepted", "status: Approved"),
  );
  other.git(["add", "."]);
  other.review();
  expect(readTaskDecisions(other.root)).toEqual([]);
  expect(() => {
    checkAgentCommit(other.root);
  }).toThrow(/human plan approval/);
});

test("review CLI defaults to current files and permits only explicit staged selection", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  const staged = f.git(["write-tree"]);
  const current = workingReviewTree(f.root);
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const command = () => {
      const review = new Command("review").exitOverride().configureOutput({ writeErr: () => undefined });
      registerAgentReviewCommands(review, f.root);
      return review;
    };
    for (const kind of ["changes", "task"]) {
      const args = kind === "task" ? [kind, "--base", f.base] : [kind];
      await command().parseAsync(args, { from: "user" });
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ tree: current });
      await command().parseAsync([...args, "--staged"], { from: "user" });
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ tree: staged });
      await expect(command().parseAsync([...args, "--working"], { from: "user" })).rejects.toThrow(/unknown option/);
    }
    expect(f.git(["write-tree"])).toBe(staged);
  } finally {
    output.mockRestore();
  }
});

test("explicit task associations survive consumed receipts and branch rebases until publication", () => {
  const f = fixture(),
    task = join(f.root, "workbench/tasks/TSK-00.md");
  writeFileSync(
    task,
    "---\nstatus: Planned\n---\n\n# TSK-0: Approved future work\n\n## Overview\n\nAn approved outcome.\n\n## Details\n\nImplementation details.\n",
  );
  changeTaskStatus(f.root, "TSK-0", "Approved", undefined, true);
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "approved plan"]);
  const upstream = f.git(["rev-parse", "HEAD"]);
  f.git(["branch", "upstream"]);
  f.git(["checkout", "-b", "implementation"]);
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "."]);
  f.review(AgentReviewKind.Changes, { tasks: ["demo:TSK-0"] });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "implement"]);
  finishAgentCommit(f.root);
  f.git(["checkout", "upstream"]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "other developer"]);
  f.git(["checkout", "implementation"]);
  f.git(["-c", "core.hooksPath=/dev/null", "rebase", "upstream"]);
  const review = f.review(AgentReviewKind.Task, { base: "upstream" });
  expect(review.tasks).toContain("demo:TSK-0");
  expect(() => {
    checkAgentPush(f.root, "HEAD", "upstream");
  }).toThrow(/human acceptance/i);
  expect(readTaskQueue(f.root).entries.map((entry) => entry.state)).toEqual(["Queued"]);
  // A remote that now contains this work retires its associations without needing an outgoing row.
  checkAgentPush(f.root, "HEAD", "HEAD");
  expect(f.review(AgentReviewKind.Task, { base: "HEAD" }).tasks).not.toContain("demo:TSK-0");
  expect(upstream).not.toBe(f.git(["rev-parse", "HEAD"]));
});

test("reviewing one task on the outgoing tree does not attest to another task's work", () => {
  const f = fixture();
  const references = ["demo:TSK-0", "demo:TSK-1"];
  for (const [index, reference] of references.entries()) {
    writeFileSync(
      join(f.root, `workbench/tasks/TSK-0${String(index)}.md`),
      `---\nstatus: Planned\n---\n\n# TSK-${String(index)}: Task ${String(index)}\n\nReview this delivery.\n`,
    );
    changeTaskStatus(f.root, reference, "Approved", undefined, true);
  }
  f.git(["add", "workbench"]);
  f.review(AgentReviewKind.Changes, { tasks: references });
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "implement two tasks"]);
  finishAgentCommit(f.root);

  const first = f.review(AgentReviewKind.Task, { base: f.base, tasks: ["demo:TSK-0"] });
  expect(first.tasks).toEqual(["demo:TSK-0"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated work review is required for demo:TSK-1/);

  f.review(AgentReviewKind.Task, { base: f.base, tasks: ["demo:TSK-1"] });
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/human acceptance/i);
});
