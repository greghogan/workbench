import { afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distribution, git } from "./adoption.mjs";
import { enableArchive } from "../../src/core/records/archive-workflow.ts";

beforeEach(() => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export const taskPath = "workbench/tasks/TSK-00.md",
  support = "workbench/tasks/TSK-00/evidence.sh";
export function archiveScratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function archiveRepository(): string {
  const root = archiveScratch("workbench-archive-workflow-");
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
