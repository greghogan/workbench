import { archiveRepository, archiveScratch } from "../../fixtures/archive-workflow.mjs";
import { expect, test } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "../../fixtures/adoption.mjs";
import { enableArchive, transferArchive, publishArchive } from "../../../src/core/records/archive-workflow.ts";
import { checkArchivePublication } from "../../../src/core/records/archive-publication.ts";

test("durable hooks reject archive edits, deletion, and rewrites after disabling while preserving prior hooks", () => {
  const root = archiveRepository(),
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

test("archive publication verifies both proposed refs and publishes archive-only history without project gates", () => {
  const root = archiveRepository(),
    remote = archiveScratch("workbench-archive-remote-");
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

test("sequential publication verifies ordering and retries either interrupted transfer without new commits", () => {
  const root = archiveRepository(),
    remote = archiveScratch("workbench-archive-sequential-");
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
  const provider = archiveRepository(),
    root = archiveScratch("workbench-archive-hook-checkout-");
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

test("restoration before the first publication retains the archives referenced by earlier source commits", () => {
  const root = archiveRepository(),
    remote = archiveScratch("workbench-archive-restored-publication-");
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
