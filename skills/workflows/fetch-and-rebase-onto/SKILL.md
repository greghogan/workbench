---
name: fetch-and-rebase-onto
description:
  Fetch a requested remote branch and rebase the current branch onto it, resolving conflicts and verifying the result.
  Require a clean index and working tree, including untracked files.
---

# Fetch and rebase onto

Example: `$fetch-and-rebase-onto origin/main`. The request authorizes fetching, replaying local commits, staging
resolutions, and continuing the rebase. Publication and mandatory human review remain separate.

Use `workbench rebase <remote/branch>` for fetching, target capture, archive and plan reconciliation, review continuity,
and recovery. It requires an attached branch and a clean index and working tree, including untracked files; ignored
artifacts are allowed. It refuses existing Git operations and preserves a recovery reference. If the CLI is unavailable,
stop for setup rather than bypassing its archive coordination. Do not stash, clean, reset, or abort unrelated work.

Use `workbench rebase --continue` after staging resolved files, or `--abort` when abandoning this requested rebase.
Archive-content conflicts require explicit resolution or restoration; never edit the protected archive branch directly.

Resolve each stopped commit against upstream intent, callers, and tests. Rebase `ours` is the rebased series; `theirs`
is the replayed commit. Avoid wholesale side selection. Follow behavior through renames/deletions; resolve manifests and
sources before regenerating lockfiles or derived output with pinned tools. Inspect reused resolutions, stage only the
resolution, and continue through the CLI without bypassing gates or skipping unresolved commits.

Stop for incompatible requirements, required human approvals, concurrent edits, or verification failures without a clear
in-scope repair. Preserve resumable state and report the precise decision or failure; never manufacture acknowledgments.

Review the old/new series with `git range-diff`, account for changed or omitted patches, and inspect merge topology
separately. Run applicable project validation and checks; confirm the rebase ended with a clean checkout. Report the
original/final commits, target, material resolutions, verification, and recovery ref. Resolve any resulting provisional
review units through `workbench commit reviews` and `commit finalize` after human decisions and renewed agent review and
checks. Leave publication to a separate request.
