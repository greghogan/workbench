import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  reviewTree,
} from "../src/agent-review.ts";
import { changeTaskStatus } from "../src/task-service.ts";
import { changeTaskQueue, readTaskQueue } from "../src/task-queue.ts";
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
  const review = (kind = AgentReviewKind.Changes, options: { base?: string; amend?: boolean } = {}) => {
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
test("every outgoing commit needs change review and the batch needs accumulated review", () => {
  const f = fixture();
  writeFileSync(join(f.root, "source.ts"), "export const value=2;\n");
  f.git(["add", "."]);
  f.review();
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "first"]);
  writeFileSync(join(f.root, "second.ts"), "export const second=1;\n");
  f.git(["add", "."]);
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "unreviewed"]);
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/no matching change review receipt/);
  const proposal = proposedAgentReview(f.root, AgentReviewKind.Changes, { amend: true });
  recordAgentReview(
    f.root,
    { ...proposal, summary: "Reviewed amended commit", verification: "Tests passed" },
    reviewIdentity(proposal),
  );
  expect(() => {
    checkAgentPush(f.root, "HEAD", f.base);
  }).toThrow(/Accumulated task review/);
  f.review(AgentReviewKind.Task, { base: f.base });
  checkAgentPush(f.root, "HEAD", f.base);
  const tree = reviewTree(f.root, "HEAD");
  f.git(["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--no-edit"]);
  expect(reviewTree(f.root, "HEAD")).toBe(tree);
  checkAgentPush(f.root, "HEAD", f.base);
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
  }).toThrow(/no matching change review/);
  f.review(AgentReviewKind.Changes, { amend: true });
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
