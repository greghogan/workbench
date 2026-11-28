import { archiveRepository, archiveScratch, taskPath } from "../../fixtures/archive-workflow.mjs";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { reserveRecordNumber } from "../../../src/core/records/record-sequences.ts";
import { validateRelationships } from "../../../src/core/records/records.ts";
import {
  approveReviewFiles,
  reviewedBaselines,
  reviewStatus,
  ReviewSource,
} from "../../../src/core/review/review-service.ts";
import { expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures/adoption.mjs";
import {
  previewArchive,
  transferArchive,
  publishArchive,
  fetchArchive,
} from "../../../src/core/records/archive-workflow.ts";
import { readArchivedFile } from "../../../src/core/records/archive-store.ts";
import { storageReviewContext } from "../../../src/core/records/archive-transfer-proof.ts";
import { checkRecordRetention } from "../../../src/core/records/record-retention.ts";
import { archiveGroups } from "../../../src/core/records/archive-groups.ts";

test("group ranges allow gaps and arbitrary positive sizes, but partial or unfinished records are visible", () => {
  const completed = (number: string) => ({
    path: `TSK-${number}`,
    scopePath: ".",
    kind: "TSK" as const,
    number,
    contents: `---\nstatus: Accepted\n---\n\n# TSK-${number}: Completed\n\nDelivered.\n`,
    reviewed: true,
  });
  const groups = archiveGroups([completed("0"), completed("ZZ"), completed("100")]);
  expect(groups.map(({ first, last, complete, eligible }) => ({ first, last, complete, eligible }))).toEqual([
    { first: "0", last: "ZZ", complete: true, eligible: true },
    { first: "100", last: "1ZZ", complete: false, eligible: true },
  ]);
  const root = archiveRepository();
  expect(previewArchive(root).map((group) => group.eligible)).toEqual([true, false]);
  expect(
    archiveGroups([completed("0"), completed("3")], 3).map((group) => [group.first, group.last, group.complete]),
  ).toEqual([
    ["0", "2", true],
    ["3", "5", false],
  ]);
});

test("experiments remain live until their completed version is reviewed in committed history", () => {
  const root = archiveRepository(),
    path = "workbench/experiments/EXP-00.md";
  mkdirSync(join(root, "workbench/experiments"));
  const body =
    "---\nstatus: Rejected\nenvironment: null\n---\n\n# EXP-0: Compared candidates\n\nCandidate was slower.\n\n## Hypothesis\n\nCandidate reduces latency.\n\n## Candidate and baseline\n\nCompare the candidate with the parent implementation.\n\n## Independent variable\n\nChange the candidate implementation.\n\n## Controls and correctness\n\nThe outputs remain equivalent.\n\n## Workload\n\nMeasure representative requests.\n\n## Evaluation rule\n\nPrefer the faster correct implementation.\n\n## Execution provenance\n\nMeasured the declared candidate and baseline.\n\n## Evidence\n\nCandidate latency exceeded baseline latency.\n\n## Decision\n\nRetain the baseline.\n";
  writeFileSync(join(root, path), body);
  git(root, "add", path);
  git(root, "commit", "-qm", "Provisional result\n\nWorkbench-Provisional: true");
  expect(previewArchive(root).find((group) => group.kind === "EXP")?.eligible).toBe(false);
  transferArchive(root);
  expect(existsSync(join(root, path))).toBe(true);
  writeFileSync(join(root, path), body + "\nReviewed conclusion.\n");
  git(root, "add", path);
  git(root, "commit", "-qm", "Reviewed result");
  transferArchive(root);
  expect(existsSync(join(root, path))).toBe(false);
  expect(readArchivedFile(root, path)?.toString()).toBe(body + "\nReviewed conclusion.\n");
});

test.each([false, true])(
  "a restricted clone explicitly acquires its archive without lazy fetches (partial: %s)",
  (partial) => {
    const root = archiveRepository(),
      remote = archiveScratch("workbench-archive-clone-remote-"),
      clone = archiveScratch("workbench-archive-clone-");
    git(remote, "init", "--bare", "-q");
    git(remote, "config", "uploadpack.allowFilter", "true");
    git(root, "remote", "add", "origin", remote);
    const operation = transferArchive(root);
    publishArchive(root);
    git(
      clone,
      "clone",
      "--no-local",
      ...(partial ? ["--filter=blob:none"] : []),
      "--single-branch",
      "--branch",
      "main",
      remote,
      ".",
    );
    expect(() => readArchivedFile(clone, taskPath)).toThrow(/unavailable locally/);
    if (partial) {
      git(clone, "fetch", "--filter=blob:none", "origin", "refs/heads/records");
      expect(() => readArchivedFile(clone, taskPath)).toThrow(/workbench record archive fetch/);
    }
    fetchArchive(clone);
    expect(git(clone, "rev-parse", "refs/heads/records")).toBe(operation.archiveAfter);
    expect(readArchivedFile(clone, taskPath)?.toString()).toContain("Delivered");
    expect(existsSync(join(clone, taskPath))).toBe(false);
    writeFileSync(join(clone, "workbench/state.toml"), '[next]\nTSK="2"\n');
    git(clone, "add", "workbench/state.toml");
    expect(() => {
      checkRecordRetention(clone);
    }).toThrow(/instead of deleting/);
  },
);

test("storage-only commits preserve document acknowledgment and logical retention without implying new review", () => {
  const root = archiveRepository(),
    path = "workbench/decisions/ADR-00.md";
  mkdirSync(join(root, "workbench/decisions"));
  writeFileSync(join(root, path), "# ADR-0: Original decision\n\nOriginal intent.\n");
  git(root, "add", path);
  git(root, "commit", "-qm", "Original decision");
  const reviewed = "# ADR-0: Revised decision\n\nReviewed intent.\n";
  writeFileSync(join(root, path), reviewed);
  const selected = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path);
  if (!selected) throw new Error("Expected pending decision");
  approveReviewFiles(root, [selected], false, ReviewSource.Working);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path)?.approved).toBe(true);
  const baselineTree = git(root, "rev-parse", "HEAD^{tree}"),
    operation = transferArchive(root);
  expect(storageReviewContext(root, "0".repeat(40), operation.after)).toBe(false);
  expect(storageReviewContext(root, baselineTree, operation.after)).toBe(true);
  expect(storageReviewContext(root, baselineTree, "HEAD")).toBe(true);
  expect(reviewedBaselines(root).get(path)?.contents).toBe(reviewed);
  expect(reviewStatus(root, ReviewSource.Working).changes.filter((change) => !change.approved)).toEqual([]);
  expect(() => {
    checkRecordRetention(root);
  }).not.toThrow();
  writeFileSync(join(root, "unrelated.txt"), "Different implementation context.\n");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-qm", "Different implementation");
  expect(storageReviewContext(root, baselineTree, "HEAD")).toBe(false);
  expect(storageReviewContext(root, baselineTree, operation.after)).toBe(true);
});

test("nested records retain cross-scope prerequisites and allocation floors while empty record groups disappear", () => {
  const root = archiveRepository(),
    nested = "app/workbench/tasks/01/TSK-0100.md",
    supporting = "app/workbench/tasks/01/TSK-0100/proof.txt";
  mkdirSync(join(root, "app/workbench/tasks/01/TSK-0100"), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    readFileSync(join(root, "workbench/projects.toml"), "utf8") + '\n[[project]]\nid="app"\npath="app"\n',
  );
  writeFileSync(join(root, "app/workbench/state.toml"), '[next]\nTSK="102"\n');
  writeFileSync(
    join(root, nested),
    "---\nstatus: Accepted\n---\n\n# TSK-100: Shared prerequisite\n\nCompleted scoped work.\n",
  );
  writeFileSync(join(root, supporting), "Preserved supporting evidence.\n");
  writeFileSync(
    join(root, "app/workbench/tasks/01/TSK-0101.md"),
    "---\nstatus: Accepted\n---\n\n# TSK-101: Another scoped delivery\n\nCompleted work.\n",
  );
  const active = "workbench/tasks/TSK-01.md";
  writeFileSync(
    join(root, active),
    readFileSync(join(root, active), "utf8").replace("status: Approved", "status: Approved\ndepends_on: [app:TSK-100]"),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Completed nested prerequisite");
  const expected = readFileSync(join(root, nested));
  transferArchive(root);
  expect(existsSync(join(root, "app/workbench/tasks/01"))).toBe(false);
  expect(readTaskGraph(root).byReference.get("sample:TSK-1")?.dependencies).toEqual(["app:TSK-100"]);
  expect(validateRelationships(root)).toEqual([]);
  rmSync(join(root, "app/workbench/state.toml"));
  expect(reserveRecordNumber(join(root, "app"), "TSK", root)).toBe("102");
  const counter = readFileSync(join(root, "app/workbench/state.toml"));
  transferArchive(root, { restore: true });
  expect(readFileSync(join(root, nested))).toEqual(expected);
  expect(readFileSync(join(root, supporting), "utf8")).toBe("Preserved supporting evidence.\n");
  expect(readFileSync(join(root, "app/workbench/state.toml"))).toEqual(counter);
});
