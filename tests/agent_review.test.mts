import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerAgentReviewCommands } from "../src/cli/agent-review.ts";
import { afterEach, test, expect, vi } from "vitest";
import { gitBytes, workingReviewTree } from "../src/git-snapshot.ts";
import {
  AgentReviewKind,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
  checkAgentCommit,
  checkAgentPush,
  finishAgentCommit,
} from "../src/agent-review.ts";
import { changeTaskStatus } from "../src/task-service.ts";
import { changeTaskQueue, readTaskQueue } from "../src/task-queue.ts";
import { changeExperimentStatus } from "../src/experiment-workflow.ts";
import { requiredExperimentProtocol } from "../src/records.ts";
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
  }).toThrow(/Accumulated task review/);
  f.review(AgentReviewKind.Task, { base: upstream });
  checkAgentPush(f.root, "HEAD", upstream);
  // Retry preserves evidence; updating the destination baseline invalidates it.
  checkAgentPush(f.root, "HEAD", upstream);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated task review/);
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
    [join(import.meta.dirname, "../bin/workbench.mjs"), "review", "finish-commit"],
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
  }).toThrow(/Accumulated task review/);
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
  }).toThrow(/Accumulated task review/);
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
  const accepted = workingReviewTree(f.root);
  expect(readTaskQueue(f.root).decisions?.find((d) => d.status === "Accepted")?.tree).toBe(accepted);
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
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "changed outcome"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/acceptance does not cover/);
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
  expect(readTaskQueue(f.root).entries).toHaveLength(0);
  // A remote that now contains this work retires its associations without needing an outgoing row.
  checkAgentPush(f.root, "HEAD", "HEAD");
  expect(f.review(AgentReviewKind.Task, { base: "HEAD" }).tasks).not.toContain("demo:TSK-0");
  expect(upstream).not.toBe(f.git(["rev-parse", "HEAD"]));
});
