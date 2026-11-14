import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { reserveRecordNumber } from "../../../src/core/records/record-sequences.ts";
import { validateRelationships } from "../../../src/core/records/records.ts";
import {
  approveReviewFiles,
  reviewedBaselines,
  reviewStatus,
  ReviewSource,
} from "../../../src/core/review/review-service.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { distribution, git } from "../../fixtures/adoption.mjs";
import {
  archiveOperation,
  enableArchive,
  previewArchive,
  recoverArchive,
  transferArchive,
  publishArchive,
  fetchArchive,
} from "../../../src/core/records/archive-workflow.ts";
import { checkArchivePublication } from "../../../src/core/records/archive-publication.ts";
import { archiveRevision, readArchiveIndex, readArchivedFile } from "../../../src/core/records/archive-store.ts";
import { verifyArchiveTransfer, storageReviewContext } from "../../../src/core/records/archive-transfer-proof.ts";
import { gitBytes } from "../../../src/core/git/git-snapshot.ts";
import { checkRecordRetention } from "../../../src/core/records/record-retention.ts";
import { hashFile } from "../../../src/core/runtime/file-reads.ts";
import { archiveGroups } from "../../../src/core/records/archive-groups.ts";

beforeEach(() => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const taskPath = "workbench/tasks/TSK-00.md",
  support = "workbench/tasks/TSK-00/evidence.sh";
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "workbench-archive-workflow-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Archive fixture");
  git(root, "config", "user.email", "archive@example.invalid");
  git(root, "config", "commit.gpgSign", "false");
  mkdirSync(join(root, "workbench/tasks/TSK-00"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\ndata="delete"\n',
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="sample"\npath="."\n');
  writeFileSync(join(root, "workbench/state.toml"), '# Preserve counters\n[next]\nTSK="2"\n');
  writeFileSync(
    join(root, taskPath),
    "---\nstatus: Accepted\n---\n\n# TSK-0: Delivered\n\nImplemented and accepted.\n",
  );
  writeFileSync(
    join(root, "workbench/tasks/TSK-01.md"),
    "---\nstatus: Approved\n---\n\n# TSK-1: Active work\n\nFuture delivery.\n",
  );
  writeFileSync(join(root, support), "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(join(root, support), 0o755);
  git(root, "add", ".");
  git(root, "update-index", "--chmod=+x", support);
  git(root, "commit", "-qm", "Completed and active records");
  writeFileSync(
    join(root, ".git/hooks/pre-commit"),
    '#!/bin/sh\nprintf ran >"$(git rev-parse --git-path previous-hook-ran)"\n',
    { mode: 0o755 },
  );
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Configure archival");
  return root;
}

test("archive and restore use two independent-history commits, preserve staged work, and retain old pinned revisions", () => {
  const root = repository(),
    original = readFileSync(join(root, taskPath));
  writeFileSync(join(root, "unrelated"), "keep staged\n");
  git(root, "add", "unrelated");
  const before = git(root, "rev-parse", "HEAD"),
    operation = transferArchive(root);
  expect(operation.completed).toBe(true);
  expect(git(root, "rev-parse", "HEAD^")).toBe(before);
  expect(git(root, "rev-list", "--count", "records")).toBe("1");
  expect(existsSync(join(root, taskPath))).toBe(false);
  expect(existsSync(join(root, "workbench/tasks/TSK-00"))).toBe(false);
  expect(readArchivedFile(root, taskPath)).toEqual(original);
  expect(readArchiveIndex(root, operation.archiveAfter).files.get(support)?.mode).toBe("100755");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated");
  expect(readFileSync(join(root, "workbench/state.toml"), "utf8")).toContain('# Preserve counters\n[next]\nTSK="2"');
  expect(verifyArchiveTransfer(root, before, operation.after)).toEqual(new Set([support, taskPath]));
  git(root, "branch", "older-checkout");
  const restored = transferArchive(root, { restore: true });
  expect(restored.completed).toBe(true);
  expect(readFileSync(join(root, taskPath))).toEqual(original);
  expect(archiveRevision(root)).toBeUndefined();
  expect(readArchiveIndex(root, restored.archiveAfter).files.size).toBe(0);
  expect(git(root, "rev-list", "--count", "records")).toBe("2");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated");
  git(root, "gc", "--prune=now");
  expect(readArchiveIndex(root, operation.archiveAfter).files.has(taskPath)).toBe(true);
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Re-enable archival");
  transferArchive(root);
  expect(git(root, "rev-list", "--count", "records")).toBe("3");
});

test("a failure after the archive commit resumes exactly once and preserves intervening user edits", () => {
  const root = repository(),
    before = git(root, "rev-parse", "HEAD");
  expect(() =>
    transferArchive(root, {
      onProgress(stage) {
        if (stage === "archive-committed") throw new Error("Interrupted progress sink");
      },
    }),
  ).toThrow("Interrupted progress sink");
  const pending = archiveOperation(root);
  expect(pending?.completed).toBe(false);
  expect(git(root, "rev-parse", "HEAD")).toBe(before);
  const original = readFileSync(join(root, taskPath));
  writeFileSync(join(root, taskPath), "intervening user edit\n");
  expect(() => recoverArchive(root)).toThrow(/changed/);
  expect(readFileSync(join(root, taskPath), "utf8")).toBe("intervening user edit\n");
  writeFileSync(join(root, taskPath), original);
  const recovered = recoverArchive(root);
  expect(recovered.after).toBe(pending?.after);
  expect(recovered.archiveAfter).toBe(pending?.archiveAfter);
  expect(git(root, "rev-list", "--count", "records")).toBe("1");
  expect(recoverArchive(root)).toEqual(recovered);
});

test("affected edits and untracked supporting files block transfers; feature branches cannot initiate them", () => {
  const root = repository(),
    before = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "workbench/tasks/TSK-00/new-evidence"), "uncommitted evidence");
  expect(() => transferArchive(root)).toThrow(/edited or staged/);
  expect(git(root, "rev-parse", "HEAD")).toBe(before);
  rmSync(join(root, "workbench/tasks/TSK-00/new-evidence"));
  git(root, "checkout", "-qb", "feature");
  expect(() => transferArchive(root)).toThrow(/Only integration branch main/);
  git(root, "checkout", "main");
  transferArchive(root);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^archive_branch.*\n/m, ""));
  expect(() => {
    enableArchive(root, { branch: "missing" });
  }).toThrow(/contains the pinned/);
  enableArchive(root, { branch: "records" });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Restore archive configuration");
  expect(transferArchive(root, { restore: true }).completed).toBe(true);
});

test("durable hooks reject archive edits, deletion, and rewrites after disabling while preserving prior hooks", () => {
  const root = repository(),
    operation = transferArchive(root);
  const attempt = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const ordinary = attempt("commit", "--allow-empty", "-qm", "Verify prior hook chaining");
  expect(ordinary.status, ordinary.stderr).toBe(0);
  expect(readFileSync(join(root, ".git/previous-hook-ran"), "utf8")).toBe("ran");
  const deleted = attempt("update-ref", "-d", "refs/heads/records");
  expect(deleted.status).not.toBe(0);
  expect(deleted.stderr).toContain("protected archive");
  const rewritten = attempt("update-ref", "refs/heads/records", operation.before, operation.archiveAfter);
  expect(rewritten.status).not.toBe(0);
  transferArchive(root, { restore: true });
  expect(attempt("branch", "-D", "records").status).not.toBe(0);
  git(root, "checkout", "--orphan", "unrelated-history");
  expect(attempt("update-ref", "-d", "refs/heads/records").status).not.toBe(0);
});

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
  const root = repository();
  expect(previewArchive(root).map((group) => group.eligible)).toEqual([true, false]);
  expect(
    archiveGroups([completed("0"), completed("3")], 3).map((group) => [group.first, group.last, group.complete]),
  ).toEqual([
    ["0", "2", true],
    ["3", "5", false],
  ]);
});

test("archive publication verifies both proposed refs and publishes archive-only history without project gates", () => {
  const root = repository(),
    remote = mkdtempSync(join(tmpdir(), "workbench-archive-remote-"));
  roots.push(remote);
  git(remote, "init", "--bare", "-q");
  git(root, "remote", "add", "origin", remote);
  const operation = transferArchive(root),
    zero = "0".repeat(operation.after.length);
  const integrationUpdate = `refs/heads/main ${operation.after} refs/heads/main ${zero}\n`;
  const archiveUpdate = `refs/heads/records ${operation.archiveAfter} refs/heads/records ${zero}\n`;
  expect(() => checkArchivePublication(root, integrationUpdate, "origin")).toThrow(/Publish and verify/);
  expect(checkArchivePublication(root, integrationUpdate + archiveUpdate, "origin")).toEqual(["refs/heads/records"]);
  publishArchive(root);
  expect(git(remote, "rev-parse", "refs/heads/records")).toBe(operation.archiveAfter);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(operation.after);
  expect(checkArchivePublication(root, integrationUpdate, "origin")).toEqual([]);
  const deletion = spawnSync("git", ["-C", root, "push", "origin", ":refs/heads/records"], { encoding: "utf8" });
  expect(deletion.status).not.toBe(0);
  expect(deletion.stderr).toContain("Cannot delete protected archive");
});

test("experiments remain live until their completed version is reviewed in committed history", () => {
  const root = repository(),
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

test("recovery pins prepared commits through garbage collection and releases anchors only after completion", () => {
  const root = repository();
  expect(() =>
    transferArchive(root, {
      onProgress(stage) {
        if (stage === "recorded") throw new Error("Interruption before either ref advances");
      },
    }),
  ).toThrow("Interruption before either ref advances");
  const pending = archiveOperation(root);
  expect(
    git(root, "for-each-ref", "--format=%(objectname)", "refs/workbench/record-transfers").split("\n"),
  ).toHaveLength(2);
  git(root, "gc", "--prune=now");
  expect(recoverArchive(root).after).toBe(pending?.after);
  expect(git(root, "for-each-ref", "refs/workbench/record-transfers")).toBe("");
  expect(() =>
    transferArchive(root, {
      restore: true,
      onProgress(stage) {
        if (stage === "integration-committed") throw new Error("Interruption before archive cleanup");
      },
    }),
  ).toThrow("Interruption before archive cleanup");
  writeFileSync(join(root, taskPath), "user edits after restoration\n");
  expect(recoverArchive(root).completed).toBe(true);
  expect(readFileSync(join(root, taskPath), "utf8")).toBe("user edits after restoration\n");
});

test.each([false, true])(
  "a restricted clone explicitly acquires its archive without lazy fetches (partial: %s)",
  (partial) => {
    const root = repository(),
      remote = mkdtempSync(join(tmpdir(), "workbench-archive-clone-remote-")),
      clone = mkdtempSync(join(tmpdir(), "workbench-archive-clone-"));
    roots.push(remote, clone);
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

test("large supporting assets transfer exactly without buffering or fixed restore size limits", () => {
  const root = repository(),
    path = join(root, support);
  truncateSync(path, 65 * 1024 * 1024);
  const expected = hashFile(path);
  git(root, "add", support);
  git(root, "commit", "-qm", "Retain large experiment evidence");
  transferArchive(root);
  expect(existsSync(path)).toBe(false);
  transferArchive(root, { restore: true });
  expect(hashFile(path)).toBe(expected);
});

test("storage-only commits preserve document acknowledgment and logical retention without implying new review", () => {
  const root = repository(),
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

test("sequential publication verifies ordering and retries either interrupted transfer without new commits", () => {
  const root = repository(),
    remote = mkdtempSync(join(tmpdir(), "workbench-archive-sequential-"));
  roots.push(remote);
  git(remote, "init", "--bare", "-q");
  git(remote, "config", "receive.advertiseAtomic", "false");
  git(root, "remote", "add", "origin", remote);
  const hook = join(remote, "hooks/pre-receive");
  const reject = (ref: string) => {
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read -r old new ref; do\n  if [ "$ref" = "${ref}" ]; then echo "Injected publication failure" >&2; exit 1; fi\ndone\n`,
      { mode: 0o755 },
    );
  };
  const archived = transferArchive(root);
  reject("refs/heads/main");
  expect(() => {
    publishArchive(root);
  }).toThrow(/publication|snapshot/i);
  expect(git(remote, "rev-parse", "refs/heads/records")).toBe(archived.archiveAfter);
  expect(git(remote, "for-each-ref", "refs/heads/main")).toBe("");
  rmSync(hook);
  publishArchive(root);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(archived.after);
  const restored = transferArchive(root, { restore: true });
  const premature = spawnSync("git", ["-C", root, "push", "origin", "records"], { encoding: "utf8" });
  expect(premature.status).not.toBe(0);
  expect(premature.stderr).toMatch(/before publishing\s+archive cleanup/);
  reject("refs/heads/records");
  expect(() => {
    publishArchive(root);
  }).toThrow(/publication|snapshot/i);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(restored.after);
  expect(git(remote, "rev-parse", "refs/heads/records")).toBe(archived.archiveAfter);
  rmSync(hook);
  publishArchive(root);
  expect(git(remote, "rev-parse", "refs/heads/records")).toBe(restored.archiveAfter);
  expect(git(root, "rev-parse", "HEAD")).toBe(restored.after);
});

test("archive-only checkouts retain archive checks and cannot bypass a tracked project push hook", () => {
  const provider = repository(),
    root = mkdtempSync(join(tmpdir(), "workbench-archive-hook-checkout-"));
  roots.push(root);
  git(root, "clone", "--no-local", provider, ".");
  git(root, "config", "user.name", "Hook fixture");
  git(root, "config", "user.email", "hook@example.invalid");
  mkdirSync(join(root, ".project-hooks"));
  writeFileSync(join(root, ".project-hooks/pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  git(root, "add", ".project-hooks");
  git(root, "commit", "-qm", "Configure project push hook");
  git(root, "config", "core.hooksPath", ".project-hooks");
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Retain integration destination");
  transferArchive(root);
  git(root, "checkout", "records");
  const project = spawnSync(
    "git",
    ["-C", root, "push", "--dry-run", "--atomic", "origin", "main:refs/heads/probe", "records:refs/heads/records"],
    {
      encoding: "utf8",
    },
  );
  expect(project.status).not.toBe(0);
  expect(project.stderr).toContain("project push hook is unavailable");
  const archive = spawnSync("git", ["-C", root, "push", "--dry-run", "origin", "records"], { encoding: "utf8" });
  expect(archive.status, archive.stderr).toBe(0);
});

test("Git checkout conversions do not become false user-edit conflicts during archival", () => {
  const root = repository();
  writeFileSync(join(root, ".gitattributes"), "*.md text eol=crlf\n");
  git(root, "add", ".gitattributes");
  git(root, "commit", "-qm", "Use checkout line endings");
  rmSync(join(root, taskPath));
  git(root, "checkout", "HEAD", "--", taskPath);
  expect(readFileSync(join(root, taskPath), "utf8")).toContain("\r\n");
  expect(git(root, "status", "--porcelain=v1", "--", taskPath)).toBe("");
  const original = gitBytes(root, ["show", `HEAD:${taskPath}`]);
  transferArchive(root);
  expect(readArchivedFile(root, taskPath)).toEqual(original);
  transferArchive(root, { restore: true });
  expect(readFileSync(join(root, taskPath), "utf8")).toBe(original.toString().replaceAll("\n", "\r\n"));
  expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
});

test("nested records retain cross-scope prerequisites and allocation floors while empty record groups disappear", () => {
  const root = repository(),
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

test("restoration before the first publication retains the archives referenced by earlier source commits", () => {
  const root = repository(),
    remote = mkdtempSync(join(tmpdir(), "workbench-archive-restored-publication-"));
  roots.push(remote);
  git(remote, "init", "--bare", "-q");
  git(remote, "config", "receive.advertiseAtomic", "false");
  git(root, "remote", "add", "origin", remote);
  const archived = transferArchive(root),
    restored = transferArchive(root, { restore: true });
  const unsafe = spawnSync("git", ["-C", root, "push", "origin", "main"], { encoding: "utf8" });
  expect(unsafe.status).not.toBe(0);
  expect(unsafe.stderr).toMatch(/before pushing commits/);
  git(root, "commit", "--amend", "--no-edit", "--reset-author");
  const rewritten = git(root, "rev-parse", "HEAD");
  publishArchive(root);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(rewritten);
  expect(git(remote, "rev-parse", "refs/heads/records")).toBe(restored.archiveAfter);
  expect(git(remote, "show", `${archived.archiveAfter}:workbench/tasks/TSK-00.md`)).toContain("Accepted");
});
