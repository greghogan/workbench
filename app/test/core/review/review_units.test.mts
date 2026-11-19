import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import {
  captureCommittedReview,
  commitVersion,
  committedReview,
  pendingCommitReviews,
  stagedMergeReview,
} from "../../../src/core/review/review-units.ts";
import {
  approveCapturedReviews,
  approveReviewFiles,
  captureReviews,
  reviewStatus,
  ReviewSource,
} from "../../../src/core/review/review-service.ts";
import { checkReview } from "../../../src/core/review/review-check.ts";
import {
  AgentReviewKind,
  checkAgentCommit,
  checkAgentUnit,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../../../src/core/review/agent-review.ts";
import { finalizationPlan, finalizeHistory, resumePreparedFinalization } from "../../../src/core/git/finalization.ts";
import { subscribeDiagnostics } from "../../../src/core/diagnostics/diagnostics.mjs";
import {
  applyInterruptedMoves,
  initRefFormat,
  linkedCheckout,
  preparedMoves,
  recoveryCases,
  refActivationInterrupted,
  stopBeforeRefActivation,
  type RefFormat,
} from "../../fixtures/ref-recovery.mts";
import type { TestContext } from "vitest";
import {
  pendingFinalizationStatus,
  queueFinalization,
  resumeFinalization,
} from "../../../src/core/git/finalization-requests.ts";
import { reconcileTaskIdentities } from "../../../src/core/git/identity-reconciliation.ts";
import {
  readTaskDecisions,
  prepareTaskDecisionChange,
  applyTaskDecisionChange,
} from "../../../src/core/tasks/task-decisions.ts";
import { retainTaskPlanApproval, readTaskPlanApproval } from "../../../src/core/tasks/task-approvals.ts";
import { taskDigest } from "../../../src/core/tasks/task-model.ts";
import { integrateBranch } from "../../../src/core/git/branch-integration.ts";
import { unsignedTagPayload, verifiedSignatureKey } from "../../../src/core/git/signatures.ts";
import { gitBytes } from "../../../src/core/git/git-snapshot.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(storage?: { format: RefFormat; context: TestContext }) {
  const root = mkdtempSync(join(tmpdir(), "workbench-units-"));
  temporary.push(root);
  if (storage) initRefFormat(root, storage.format, storage.context);
  else git(root, "init", "-qb", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[review]\nchanges=true\n",
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  const base = git(root, "rev-parse", "HEAD"),
    path = "workbench/decisions/ADR-00.md";
  const commit = (body: string, signed = false) => {
    writeFileSync(join(root, path), `---\nsummary: Fixture.\n---\n\n# ADR-0: Fixture\n\n${body}\n`);
    git(root, "add", path);
    git(root, "commit", ...(signed ? ["--gpg-sign"] : []), "-qm", `${body}\n\nWorkbench-Provisional: true`);
    return git(root, "rev-parse", "HEAD");
  };
  const agent = (revision: string) => {
    const review = proposedAgentReview(root, AgentReviewKind.Changes, { commit: revision });
    recordAgentReview(
      root,
      {
        ...review,
        summary: "Reviewed this exact commit",
        verification: "Fixture verifies retained parent boundaries and protected contents",
      },
      reviewIdentity(review),
      false,
      revision,
    );
  };
  return { root, path, base, commit, agent };
}
test("later approval cannot approve an earlier intermediate version, and working edits form another unit", () => {
  const f = fixture(),
    first = f.commit("First choice"),
    second = f.commit("Second choice");
  expect(reviewStatus(f.root, ReviewSource.Working).changes).toEqual([]);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, second).captured, false);
  expect(committedReview(f.root, second).pending).toBe(0);
  expect(committedReview(f.root, first).pending).toBe(1);
  rmSync(join(f.root, ".git/workbench/review.json"));
  expect(committedReview(f.root, second).pending).toBe(1);
  expect(committedReview(f.root, "HEAD").revision).toBe(second);
  writeFileSync(join(f.root, f.path), readFileSync(join(f.root, f.path), "utf8") + "Working refinement.\n");
  expect(reviewStatus(f.root, ReviewSource.Working).changes[0]?.approved).toBe(false);
  expect(pendingCommitReviews(f.root).map((unit) => unit.revision)).toEqual([first, second]);
});
test("cached comparisons follow the current Git directory without inheriting another repository's consent", () => {
  const f = fixture(),
    revision = f.commit("Reviewed contents"),
    metadata = mkdtempSync(join(tmpdir(), "workbench-review-stores-")),
    original = join(metadata, "original.git"),
    replacement = join(metadata, "replacement.git");
  temporary.push(metadata);
  renameSync(join(f.root, ".git"), original);
  const select = (directory: string) => {
    writeFileSync(join(f.root, ".git"), `gitdir: ${directory.replaceAll("\\", "/")}\n`);
  };
  select(original);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);
  const acknowledged = committedReview(f.root, revision);
  expect(acknowledged.pending).toBe(0);
  const saved = readFileSync(acknowledged.receipt, "utf8");
  git(f.root, "clone", "--bare", original, replacement);
  git(f.root, "--git-dir", replacement, "config", "core.bare", "false");
  git(f.root, "--git-dir", replacement, "config", "core.worktree", f.root);
  select(replacement);
  expect(committedReview(f.root, revision).pending).toBe(1);
  expect(committedReview(f.root, revision).receipt).not.toBe(acknowledged.receipt);
  expect(readFileSync(acknowledged.receipt, "utf8")).toBe(saved);
  select(original);
  expect(committedReview(f.root, revision).pending).toBe(0);
});

test("many retained versions keep real acknowledgments; finalization preserves trees, authors, dirty work, and recovery", () => {
  const f = fixture(),
    commits: string[] = [];
  for (let index = 0; index < 5; index++) {
    const commit = f.commit(`Choice ${String(index)}`);
    commits.push(commit);
    f.agent(commit);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, commit).captured, false);
  }
  expect(pendingCommitReviews(f.root).every((unit) => unit.pending === 0)).toBe(true);
  const captured = finalizationPlan(f.root);
  expect(captured.problems).toEqual([]);
  writeFileSync(join(f.root, "unrelated.txt"), "Uncommitted work\n");
  expect(() => finalizeHistory(f.root, "stale")).toThrow(/changed/);
  const result = finalizeHistory(f.root, captured.digest);
  expect(result.replacements).toHaveLength(5);
  expect(git(f.root, "rev-parse", result.recovery)).toBe(commits.at(-1));
  expect(readFileSync(join(f.root, "unrelated.txt"), "utf8")).toBe("Uncommitted work\n");
  for (const replacement of result.replacements) {
    expect(git(f.root, "show", "-s", "--format=%T %an %ae %aI", replacement.before)).toBe(
      git(f.root, "show", "-s", "--format=%T %an %ae %aI", replacement.after),
    );
    expect(git(f.root, "show", "-s", "--format=%B", replacement.after)).not.toContain("Workbench-Provisional");
    expect(committedReview(f.root, replacement.after).pending).toBe(0);
  }
  expect(finalizationPlan(f.root).units).toEqual([]);
});
test("finalization refuses missing agent evidence, missing human review, and remotely published checkpoints", () => {
  const f = fixture(),
    first = f.commit("Choice");
  expect(finalizationPlan(f.root).problems.join("\n")).toMatch(/human review/);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  expect(finalizationPlan(f.root).problems.join("\n")).toMatch(/Agent change review/);
  f.agent(first);
  git(f.root, "update-ref", "refs/remotes/origin/draft", first);
  const plan = finalizationPlan(f.root);
  expect(plan.problems.join("\n")).toMatch(/published history/);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(/published history/);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(first);
});

test("finalization removes only the reserved trailer from a retained message", () => {
  const f = fixture();
  f.commit("Clarify commit requirements.");
  const body = "Clarify commit requirements.\n\nWorkbench-Provisional: true\nAn example in the body.\n\n";
  const otherTrailers = "Reviewed-by: Fixture\nFollow-up:\n";
  const message = join(f.root, ".git/message");
  writeFileSync(message, `${body}Reviewed-by: Fixture\nWorkbench-Provisional: true\nFollow-up:\n`);
  git(f.root, "commit", "--amend", "--cleanup=verbatim", "--file", message);
  const revision = git(f.root, "rev-parse", "HEAD");
  f.agent(revision);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);

  const result = finalizeHistory(f.root, finalizationPlan(f.root).digest);
  expect(commitVersion(f.root, result.after).message).toBe(body + otherTrailers);
});

test("partial finalization preserves pending descendants, the index, and later acknowledgments", () => {
  const f = fixture(),
    first = f.commit("Ready predecessor"),
    pending = f.commit("Pending predecessor");
  writeFileSync(join(f.root, "bridge.txt"), "A regular commit in the provisional ancestry.\n");
  git(f.root, "add", "bridge.txt");
  git(f.root, "commit", "-qm", "Unmarked bridge");
  const later = f.commit("Reviewed successor");
  for (const revision of [first, pending, later]) f.agent(revision);
  for (const revision of [first, later])
    approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);
  writeFileSync(join(f.root, "stage.txt"), "Preserve this staged data.\n");
  git(f.root, "add", "stage.txt");
  writeFileSync(join(f.root, "stage.txt"), "Preserve this working edit too.\n");
  const index = readFileSync(join(f.root, ".git/index"));

  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(plan.problems.join("\n")).toMatch(/Earlier provisional work/);
  const operation = finalizeHistory(f.root, plan.digest),
    retained = pendingCommitReviews(f.root);
  expect(operation.finalized).toBe(1);
  expect(retained.map((unit) => [unit.message.split("\n")[0], unit.pending])).toEqual([
    ["Pending predecessor", 1],
    ["Reviewed successor", 0],
  ]);
  expect(commitVersion(f.root, operation.after).tree).toBe(commitVersion(f.root, later).tree);
  expect(readFileSync(join(f.root, ".git/index"))).toEqual(index);
  expect(readFileSync(join(f.root, "stage.txt"), "utf8")).toBe("Preserve this working edit too.\n");
  const next = retained[0]?.revision ?? "";
  expect(next).not.toBe(pending);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, next).captured, false);
  const ready = finalizationPlan(f.root);
  expect(ready.eligible).toEqual(retained.map((unit) => unit.revision));
  finalizeHistory(f.root, ready.digest);
  expect(pendingCommitReviews(f.root)).toEqual([]);
});

test("a published tag protects the complete rewrite even without any remote-tracking branch", () => {
  const f = fixture(),
    first = f.commit("Reviewed local policy"),
    remote = mkdtempSync(join(tmpdir(), "workbench-finalization-remote-"));
  temporary.push(remote);
  git(remote, "init", "--bare", "-q");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  git(f.root, "tag", "-a", "released", "-m", "Retained release annotation");
  const tag = git(f.root, "rev-parse", "refs/tags/released");
  git(f.root, "remote", "add", "published", remote);
  git(f.root, "push", "-q", "published", "refs/tags/released");
  expect(git(f.root, "for-each-ref", "refs/remotes")).toBe("");
  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(/Preserve published tag/);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(first);
  expect(git(f.root, "rev-parse", "refs/tags/released")).toBe(tag);
  expect(git(f.root, "for-each-ref", "refs/workbench/recovery")).toBe("");
});

test("a retained review schedules the branch containing it and waits for a named checkout", () => {
  const f = fixture();
  git(f.root, "switch", "-qc", "feature");
  const feature = f.commit("Feature policy");
  f.agent(feature);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, feature).captured, false);
  git(f.root, "switch", "-q", "main");
  expect(queueFinalization(f.root, { revision: feature })).toEqual(["refs/heads/feature"]);
  resumeFinalization(f.root);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
  expect(git(f.root, "rev-parse", "feature")).toBe(feature);
  git(f.root, "switch", "-q", "feature");
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    provisional: false,
    tree: commitVersion(f.root, feature).tree,
  });
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});

test("unattended finalization retains an unsigned result when the repository signer needs a terminal", () => {
  const f = fixture(),
    prior = f.commit("Reviewed policy");
  f.agent(prior);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, prior).captured, false);
  git(f.root, "config", "commit.gpgSign", "true");
  git(f.root, "config", "gpg.program", join(f.root, "interactive-signing-only"));
  queueFinalization(f.root, { revision: prior });
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    tree: commitVersion(f.root, prior).tree,
    signed: false,
    provisional: false,
  });
  expect(pendingCommitReviews(f.root)).toEqual([]);
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});

test("a working record's finalization request survives an unrelated commit", () => {
  const f = fixture();
  writeFileSync(join(f.root, f.path), "---\nsummary: Fixture.\n---\n\n# ADR-0: Fixture\n\nReviewed decision.\n");
  const captured = reviewStatus(f.root, ReviewSource.Working);
  approveReviewFiles(f.root, captured.changes, false, ReviewSource.Working);
  queueFinalization(f.root);
  resumeFinalization(f.root);
  expect(pendingFinalizationStatus(f.root)).toMatch(/retained in Git/);

  writeFileSync(join(f.root, "unrelated.txt"), "Independent work.\n");
  git(f.root, "add", "unrelated.txt");
  git(f.root, "commit", "-qm", "Retain independent work");
  resumeFinalization(f.root);
  expect(pendingFinalizationStatus(f.root)).toMatch(/retained in Git/);

  const delivery = f.commit("Reviewed decision.");
  f.agent(delivery);
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    tree: commitVersion(f.root, delivery).tree,
    provisional: false,
  });
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});

test.for(["terminal", "background", "unavailable key", "different key", "foreign author"] as const)(
  "finalization preserves reviewed content and signed recovery history with %s",
  (mode, { skip }) => {
    const f = fixture();
    const key = (name: string) => {
      const file = join(f.root, ".git", name),
        generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8" });
      if (generated.error && (generated.error as NodeJS.ErrnoException).code === "ENOENT")
        skip("OpenSSH signing is unavailable on this host");
      expect(generated.status, generated.stderr).toBe(0);
      return file;
    };
    const original = key("original-key"),
      other = key("other-key"),
      signers = join(f.root, ".git/signers");
    writeFileSync(
      signers,
      [original, other].map((file) => `review@example.invalid ${readFileSync(file + ".pub", "utf8")}`).join(""),
    );
    git(f.root, "config", "gpg.format", "ssh");
    git(f.root, "config", "gpg.ssh.program", "ssh-keygen");
    git(f.root, "config", "gpg.ssh.allowedSignersFile", signers);
    git(f.root, "config", "user.signingkey", original);
    git(f.root, "config", "commit.gpgSign", "false");
    const tagged = f.commit("Reviewed starting point");
    f.agent(tagged);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, tagged).captured, false);
    git(f.root, "tag", "--sign", "--message", "Original annotation\n\nKeep this paragraph.", "reviewed", tagged);
    const tag = git(f.root, "rev-parse", "refs/tags/reviewed"),
      originalPayload = unsignedTagPayload(gitBytes(f.root, ["cat-file", "tag", tag])),
      signer = verifiedSignatureKey(f.root, "tag", tag);
    git(f.root, "config", "commit.gpgSign", "true");
    const signedCommit = f.commit("Reviewed signed successor", true);
    f.agent(signedCommit);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, signedCommit).captured, false);
    if (mode === "unavailable key") git(f.root, "config", "user.signingkey", join(f.root, "missing-key"));
    if (mode === "different key") git(f.root, "config", "user.signingkey", other);
    if (mode === "foreign author") {
      git(f.root, "config", "user.name", "Other Author");
      expect(() => finalizeHistory(f.root, finalizationPlan(f.root).digest, false, true)).toThrow(/tagger.*differs/);
      expect(git(f.root, "rev-parse", "refs/tags/reviewed")).toBe(tag);
      git(f.root, "tag", "-d", "reviewed");
      expect(() => finalizeHistory(f.root, finalizationPlan(f.root).digest, false, true)).toThrow(/author.*differs/);
      expect(git(f.root, "rev-parse", "HEAD")).toBe(signedCommit);
      expect(git(f.root, "for-each-ref", "--format=%(refname)", "refs/workbench/recovery")).toBe("");
      return;
    }
    const final = finalizeHistory(f.root, finalizationPlan(f.root).digest, false, mode === "background"),
      replaced = git(f.root, "rev-parse", "refs/tags/reviewed^{commit}"),
      newTag = git(f.root, "rev-parse", "refs/tags/reviewed");
    expect(replaced).not.toBe(tagged);
    expect(commitVersion(f.root, final.after)).toMatchObject({
      signed: mode === "terminal",
      provisional: false,
      parents: [replaced],
      tree: commitVersion(f.root, signedCommit).tree,
    });
    const replacementTag = gitBytes(f.root, ["cat-file", "tag", newTag]);
    if (mode === "terminal") {
      expect(verifiedSignatureKey(f.root, "commit", final.after)).toBe(
        verifiedSignatureKey(f.root, "commit", signedCommit),
      );
      expect(verifiedSignatureKey(f.root, "tag", newTag)).toBe(signer);
    } else expect(unsignedTagPayload(replacementTag)).toEqual(replacementTag);
    expect(unsignedTagPayload(replacementTag)).toEqual(
      Buffer.concat([Buffer.from(`object ${replaced}`), originalPayload.subarray(originalPayload.indexOf(10))]),
    );
    expect(git(f.root, "rev-parse", final.recovery)).toBe(signedCommit);
    expect(git(f.root, "rev-parse", `${final.recovery.replace(/\/before$/, "")}/before-refs/refs/tags/reviewed`)).toBe(
      tag,
    );
  },
);

test("a ready merge side moves its linked branch and both tag forms together", () => {
  const f = fixture(),
    first = f.commit("Ready merge side");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  const linked = mkdtempSync(join(tmpdir(), "workbench-finalization-linked-"));
  temporary.push(linked);
  git(f.root, "worktree", "add", "-qb", "linked", linked, first);
  writeFileSync(join(linked, "linked.txt"), "Linked branch source.\n");
  git(linked, "add", "linked.txt");
  git(linked, "commit", "-qm", "Linked descendant");
  const linkedBefore = git(linked, "rev-parse", "HEAD");
  git(f.root, "tag", "light", first);
  git(f.root, "tag", "-a", "annotated", "-m", "Keep this exact annotation", linkedBefore);
  const annotation = git(f.root, "cat-file", "tag", "refs/tags/annotated").split("\n").slice(1).join("\n");
  git(f.root, "switch", "-qc", "pending", f.base);
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(f.root, "workbench/decisions/ADR-01.md"),
    "---\nsummary: Pending side.\n---\n\n# ADR-1: Pending side\n",
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Pending side\n\nWorkbench-Provisional: true");
  const other = git(f.root, "rev-parse", "HEAD");
  f.agent(other);
  git(f.root, "switch", "-q", "main");
  git(f.root, "merge", "--no-commit", "--no-ff", "pending");
  git(f.root, "commit", "-qm", "Merge both sides\n\nWorkbench-Provisional: true");
  const merge = commitVersion(f.root, "HEAD");
  f.agent(merge.revision);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, merge.revision).captured, false);
  const linkedIndex = readFileSync(join(git(linked, "rev-parse", "--absolute-git-dir"), "index"));

  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(plan.references.map((ref) => ref.name)).toEqual([
    "refs/heads/linked",
    "refs/heads/main",
    "refs/tags/annotated",
    "refs/tags/light",
  ]);
  const result = finalizeHistory(f.root, plan.digest),
    updated = commitVersion(f.root, result.after),
    light = git(f.root, "rev-parse", "refs/tags/light"),
    linkedAfter = git(linked, "rev-parse", "HEAD");
  expect(light).not.toBe(first);
  expect(linkedAfter).not.toBe(linkedBefore);
  expect(updated).toMatchObject({ tree: merge.tree, parents: [light, other], provisional: true });
  expect(committedReview(f.root, updated.revision).pending).toBe(0);
  expect(commitVersion(f.root, light).provisional).toBe(false);
  expect(git(f.root, "rev-parse", "refs/tags/annotated^{commit}")).toBe(linkedAfter);
  expect(git(f.root, "cat-file", "tag", "refs/tags/annotated").split("\n").slice(1).join("\n")).toBe(annotation);
  expect(readFileSync(join(git(linked, "rev-parse", "--absolute-git-dir"), "index"))).toEqual(linkedIndex);
  expect(git(linked, "status", "--porcelain")).toBe("");
});

test("a task across both merge sides waits for all reviews and acceptance in retained history", () => {
  const f = fixture(),
    reference = "demo:TSK-0",
    relative = "workbench/tasks/TSK-00.md",
    task = (outcome: string, status = "Approved") =>
      `---\nstatus: ${status}\n---\n\n# TSK-0: Shared delivery\n\n${outcome}\n`;
  mkdirSync(join(f.root, "workbench/tasks"));
  writeFileSync(join(f.root, relative), task("Deliver both parts."));
  writeFileSync(
    join(f.root, "workbench/config.toml"),
    readFileSync(join(f.root, "workbench/config.toml"), "utf8") + "tasks=true\ntask_approvals=true\n",
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Approved shared delivery");
  const base = git(f.root, "rev-parse", "HEAD");
  writeFileSync(join(f.root, relative), task("Delivered the first part."));
  git(f.root, "add", relative);
  const first = f.commit("First part policy");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);

  git(f.root, "switch", "-qc", "other", base);
  const secondPath = "workbench/decisions/ADR-01.md",
    secondPolicy = "---\nsummary: Second part policy.\n---\n\n# ADR-1: Second part\n";
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  writeFileSync(join(f.root, relative), task("Delivered the second part."));
  writeFileSync(join(f.root, secondPath), secondPolicy);
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Second part\n\nWorkbench-Provisional: true");
  const other = git(f.root, "rev-parse", "HEAD");
  f.agent(other);
  git(f.root, "switch", "-q", "main");
  const combined = "Delivered both parts together.",
    accepted = task(combined, "Accepted");
  writeFileSync(join(f.root, relative), task(combined));
  writeFileSync(join(f.root, secondPath), secondPolicy);
  git(f.root, "add", ".");
  const merge = git(
    f.root,
    "commit-tree",
    git(f.root, "write-tree"),
    "-p",
    first,
    "-p",
    other,
    "-m",
    "Combined delivery\n\nWorkbench-Provisional: true",
  );
  git(f.root, "update-ref", "refs/heads/main", merge, first);
  f.agent(merge);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, merge).captured, false);
  const review = proposedAgentReview(f.root, AgentReviewKind.Task, { commit: merge, base });
  recordAgentReview(
    f.root,
    { ...review, summary: "Reviewed both parts together", verification: "Verified both retained sides" },
    reviewIdentity(review),
    false,
    merge,
  );
  expect(finalizationPlan(f.root).eligible).toEqual([]);

  approveCapturedReviews(f.root, captureCommittedReview(f.root, other).captured, false);
  writeFileSync(join(f.root, relative), accepted);
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, reference, () => [
      {
        reference,
        status: "Accepted",
        updated: new Date().toISOString(),
        digest: taskDigest(accepted),
        outcome: taskDigest(accepted),
      },
    ]),
  );
  const working = finalizationPlan(f.root);
  expect(working.eligible).toEqual([]);
  expect(working.problems.join("\n")).toMatch(/human acceptance is required/);

  git(f.root, "add", relative);
  git(f.root, "commit", "-qm", "Retain delivery acceptance");
  expect(new Set(finalizationPlan(f.root).eligible)).toEqual(new Set([first, other, merge]));

  const amended = task(combined + " Refined the second part after review.", "Accepted");
  writeFileSync(join(f.root, relative), amended);
  git(f.root, "add", relative);
  git(f.root, "commit", "-qm", "Refine the retained outcome");
  expect(finalizationPlan(f.root).eligible).toEqual([]);
  const refreshed = proposedAgentReview(f.root, AgentReviewKind.Task, { commit: "HEAD", base });
  recordAgentReview(
    f.root,
    { ...refreshed, summary: "Reviewed the refinement", verification: "Verified the complete updated delivery" },
    reviewIdentity(refreshed),
    false,
    "HEAD",
  );
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, reference, (previous) => [
      ...previous,
      {
        reference,
        status: "Accepted",
        updated: new Date().toISOString(),
        digest: taskDigest(amended),
        outcome: taskDigest(amended),
      },
    ]),
  );
  const plan = finalizationPlan(f.root);
  expect(new Set(plan.eligible)).toEqual(new Set([first, other, merge]));
  expect(finalizeHistory(f.root, plan.digest).finalized).toBe(3);
  expect(pendingCommitReviews(f.root)).toEqual([]);
});

test("a merge requires review of the result against every parent in order", () => {
  const f = fixture();
  git(f.root, "switch", "-qc", "side");
  writeFileSync(join(f.root, "side.txt"), "Side contribution\n");
  git(f.root, "add", "side.txt");
  git(f.root, "commit", "-qm", "Side contribution");
  const side = git(f.root, "rev-parse", "HEAD");

  git(f.root, "switch", "-q", "main");
  writeFileSync(join(f.root, "main.txt"), "Main contribution\n");
  git(f.root, "add", "main.txt");
  git(f.root, "commit", "-qm", "Main contribution");
  const main = git(f.root, "rev-parse", "HEAD");
  git(f.root, "merge", "--no-commit", "--no-ff", "side");
  writeFileSync(join(f.root, "integration.txt"), "A choice made during the merge\n");
  writeFileSync(join(f.root, f.path), "---\nsummary: Merge choice.\n---\n\n# ADR-0: Integrate both sides\n");
  git(f.root, "add", "integration.txt", f.path);
  const tree = git(f.root, "write-tree");
  const linear = git(f.root, "commit-tree", tree, "-p", main, "-m", "First-parent-only comparison");
  f.agent(linear);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, linear).captured, false);
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/Change review is required/);
  expect(() => {
    checkReview(f.root, tree);
  }).toThrow(/compare the staged merge against each parent/);
  const staged = stagedMergeReview(f.root, tree);
  if (!staged) throw new Error("Expected a staged merge review");
  approveCapturedReviews(f.root, captureReviews(f.root, staged.changes, staged.source, staged.snapshot), false);
  expect(() => {
    checkReview(f.root, tree);
  }).not.toThrow();

  const review = proposedAgentReview(f.root, AgentReviewKind.Changes, { staged: true });
  expect(review.parentTrees).toEqual([
    git(f.root, "rev-parse", main + "^{tree}"),
    git(f.root, "rev-parse", side + "^{tree}"),
  ]);
  recordAgentReview(
    f.root,
    { ...review, summary: "Reviewed both sides and the merge choice", verification: "Compared the complete result" },
    reviewIdentity(review),
    true,
  );
  expect(() => {
    checkAgentCommit(f.root);
  }).not.toThrow();

  git(f.root, "commit", "-qm", "Merge\n\nWorkbench-Provisional: true");
  const merge = commitVersion(f.root, "HEAD");
  expect(committedReview(f.root, merge.revision).pending).toBe(0);
  expect(() => {
    checkAgentUnit(f.root, merge);
  }).not.toThrow();
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [side, main] });
  }).toThrow(/Agent change review/);
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [main, f.base] });
  }).toThrow(/Agent change review/);

  const rewritten = git(
    f.root,
    "commit-tree",
    git(f.root, "rev-parse", side + "^{tree}"),
    "-p",
    f.base,
    "-m",
    "New ID",
  );
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [main, rewritten] });
  }).not.toThrow();
});

test("human merge acknowledgment binds a record to the result and all ordered parents", () => {
  const f = fixture(),
    main = f.commit("Main decision"),
    result = git(f.root, "rev-parse", `${main}^{tree}`);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, main).captured, false);
  git(f.root, "switch", "-qc", "side", f.base);
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  const side = f.commit("Distinct side decision");
  approveCapturedReviews(f.root, captureCommittedReview(f.root, side).captured, false);
  git(f.root, "switch", "-q", "main");
  const merge = (left: string, right: string) =>
    git(
      f.root,
      "commit-tree",
      result,
      "-p",
      left,
      "-p",
      right,
      "-m",
      "Choose the main decision\n\nWorkbench-Provisional: true",
    );
  const chosen = merge(main, side);
  git(f.root, "update-ref", "refs/heads/main", chosen, main);
  const review = captureCommittedReview(f.root, chosen);
  expect(review.unit.pending).toBe(1);
  expect(review.unit.changes[0]).toMatchObject({ path: f.path, merge: { tree: result } });
  expect(review.unit.changes[0]?.before).toBe(review.unit.changes[0]?.after);
  approveCapturedReviews(f.root, review.captured, false);

  const after = f.commit("Later provisional decision");
  approveCapturedReviews(f.root, captureCommittedReview(f.root, after).captured, false);
  const copied = git(f.root, "commit-tree", result, "-p", f.base, "-m", "Replacement identity");
  expect(committedReview(f.root, merge(copied, side)).pending).toBe(0);
  expect(committedReview(f.root, merge(side, main)).pending).toBe(1);
  expect(committedReview(f.root, chosen).pending).toBe(0);
});

test("mechanical renumbering preserves actual plan and document approval, including supporting files", () => {
  const f = fixture(),
    previous = "workbench/tasks/TSK-00",
    next = "workbench/tasks/TSK-01",
    contents = "---\nstatus: Approved\n---\n\n# TSK-0: Deliver a tool\n\nImplement the approved tool.\n",
    at = new Date().toISOString(),
    files = [
      { name: "context.txt", contents: Buffer.from("Supporting context\n").toString("base64"), executable: false },
    ];
  mkdirSync(join(f.root, previous), { recursive: true });
  writeFileSync(join(f.root, previous + ".md"), contents);
  writeFileSync(join(f.root, previous, "context.txt"), "Supporting context\n");
  git(f.root, "add", "workbench/tasks");
  const before = f.commit("Use demo:TSK-0 for this work.");
  const snapshot = retainTaskPlanApproval(f.root, { reference: "demo:TSK-0", at, contents, files });
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, "demo:TSK-0", () => [
      { reference: "demo:TSK-0", status: "Approved", digest: taskDigest(contents), snapshot, updated: at },
    ]),
  );
  approveCapturedReviews(f.root, captureCommittedReview(f.root, before).captured, false);
  renameSync(join(f.root, previous), join(f.root, next));
  renameSync(join(f.root, previous + ".md"), join(f.root, next + ".md"));
  writeFileSync(join(f.root, next + ".md"), contents.replace("TSK-0", "TSK-1"));
  writeFileSync(join(f.root, f.path), readFileSync(join(f.root, f.path), "utf8").replace("demo:TSK-0", "demo:TSK-1"));
  git(f.root, "add", ".");
  git(f.root, "commit", "--amend", "--no-edit", "-q");
  const after = git(f.root, "rev-parse", "HEAD");
  reconcileTaskIdentities(f.root, before, after);
  const approval = readTaskDecisions(f.root).find((decision) => decision.reference === "demo:TSK-1");
  expect(approval?.updated).toBe(at);
  if (!approval) throw new Error("Renumbered plan approval missing");
  expect(readTaskPlanApproval(f.root, approval)?.files).toEqual(files);
  expect(committedReview(f.root, after).pending).toBe(0);
  writeFileSync(
    join(f.root, next + ".md"),
    contents.replace("TSK-0", "TSK-1").replace("approved tool", "different tool"),
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "--amend", "--no-edit", "-q");
  expect(() => {
    reconcileTaskIdentities(f.root, before, git(f.root, "rev-parse", "HEAD"));
  }).toThrow(/lost|meaning/);
  expect(readTaskDecisions(f.root).find((decision) => decision.reference === "demo:TSK-1")?.updated).toBe(at);
});

test("rebasing accepted history without private receipts preserves unchanged document authority and renews agent evidence", () => {
  const f = fixture(),
    first = f.commit("Preserved policy.");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  const initial = finalizationPlan(f.root);
  finalizeHistory(f.root, initial.digest);
  git(f.root, "branch", "feature");
  const remote = mkdtempSync(join(tmpdir(), "workbench-units-remote-"));
  temporary.push(remote);
  git(f.root, "clone", "--bare", f.root, remote + "/repository.git");
  const clone = join(remote, "clone");
  git(f.root, "clone", remote + "/repository.git", clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  git(clone, "checkout", "-B", "main", f.base);
  writeFileSync(join(clone, "upstream.txt"), "Additional upstream source.\n");
  git(clone, "add", "upstream.txt");
  git(clone, "commit", "-qm", "Upstream source");
  git(clone, "checkout", "feature");
  expect(existsSync(join(clone, ".git/workbench/review.json"))).toBe(false);
  integrateBranch(clone, "rebase", { target: "main" });
  const units = pendingCommitReviews(clone);
  expect(units).toHaveLength(1);
  expect(units[0]?.pending).toBe(0);
  expect(existsSync(join(clone, ".git/workbench/review.json"))).toBe(false);
  expect(finalizationPlan(clone).problems.join("\n")).toMatch(/Agent change review/);
  const current = proposedAgentReview(clone, AgentReviewKind.Changes, { commit: "HEAD" });
  recordAgentReview(
    clone,
    {
      ...current,
      summary: "Reviewed the rebased task",
      verification: "Verified the new full snapshot and preserved policy",
    },
    reviewIdentity(current),
    false,
    "HEAD",
  );
  const plan = finalizationPlan(clone);
  expect(plan.problems).toEqual([]);
  finalizeHistory(clone, plan.digest);
  expect(readFileSync(join(clone, "upstream.txt"), "utf8")).toContain("Additional upstream");
  expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/workbench/review-authority")).toBe("");
});

test.for(recoveryCases)(
  "finalization resumes from the linked checkout with %s refs interrupted %s",
  ([format, stage], context) => {
    const f = fixture({ format, context }),
      first = f.commit("Recoverable policy.");
    f.agent(first);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
    const linked = linkedCheckout(f.root, "shared");
    git(f.root, "tag", "-am", "Original annotation", "recovery-test");
    const stop = stopBeforeRefActivation(f.root),
      plan = finalizationPlan(f.root);
    const dirty = join(linked, f.path);
    writeFileSync(dirty, readFileSync(dirty, "utf8") + "\nPrivate edit.\n");
    const staged = git(linked, "write-tree"),
      status = git(linked, "status", "--porcelain");

    expect(() => finalizeHistory(f.root, plan.digest)).toThrow(refActivationInterrupted);
    const moves = preparedMoves(f.root, "finalization");
    expect(moves.map(({ name }) => name)).toEqual(["refs/heads/main", "refs/heads/shared", "refs/tags/recovery-test"]);
    for (const { name, before } of moves) expect(git(f.root, "rev-parse", name)).toBe(before);
    stop();
    applyInterruptedMoves(f.root, moves, stage);
    git(f.root, "reflog", "expire", "--expire=now", "--all");
    git(f.root, "gc", "--prune=now");

    const messages: string[] = [],
      unsubscribe = subscribeDiagnostics(({ message }) => {
        if (message) messages.push(message);
      });
    try {
      expect(resumePreparedFinalization(linked)?.completed).toBe(true);
      expect(resumePreparedFinalization(linked)).toBeUndefined();
    } finally {
      unsubscribe();
    }
    expect(messages.filter((message) => message.includes("reftable"))).toHaveLength(stage === "partial" ? 1 : 0);
    for (const { name, after } of moves) expect(git(f.root, "rev-parse", name)).toBe(after);
    expect(git(f.root, "for-each-ref", "--format=%(contents:subject)", "refs/tags/recovery-test")).toBe(
      "Original annotation",
    );
    expect(git(linked, "status", "--porcelain")).toBe(status);
    expect(git(linked, "write-tree")).toBe(staged);
    expect(pendingCommitReviews(f.root)).toEqual([]);
  },
);

test("automatic finalization leaves prepared refs untouched when review or publication authority changed", () => {
  const f = fixture(),
    first = f.commit("Reviewed but unpublished policy.");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  git(f.root, "tag", "recovery-test");
  const plan = finalizationPlan(f.root);
  const stop = stopBeforeRefActivation(f.root);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(refActivationInterrupted);
  stop();
  const moves = preparedMoves(f.root, "finalization");
  git(f.root, "update-ref", "refs/remotes/origin/archive", first);

  expect(() => resumePreparedFinalization(f.root)).toThrow(/Review set changed/);
  for (const { name, before, after } of moves) {
    expect(git(f.root, "rev-parse", name)).toBe(before);
    expect(git(f.root, "cat-file", "-t", after)).toBe("commit");
  }
  git(f.root, "update-ref", "-d", "refs/remotes/origin/archive");
  expect(resumePreparedFinalization(f.root)?.completed).toBe(true);
});
