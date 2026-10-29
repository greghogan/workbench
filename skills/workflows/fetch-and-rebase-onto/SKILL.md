---
name: fetch-and-rebase-onto
description:
  Fetch a requested remote branch and rebase the current branch onto it, resolving conflicts and verifying the result.
  Require a clean index and working tree, including untracked files.
---

# Fetch and rebase onto

Example: `$fetch-and-rebase-onto origin/main`. The request authorizes fetching, replaying local commits, staging
resolutions, and continuing the rebase. Publication and mandatory human review remain separate.

Before fetching or changing refs, require an attached branch, exclusive use of the checkout, and empty
`git status --porcelain=v1 --untracked-files=all`. Refuse staged, unstaged, or untracked work, or an existing rebase,
merge, cherry-pick, or revert. Ignored artifacts are allowed. Resolve metadata paths through Git for linked worktrees.
Report blockers without stashing, temporary commits, cleaning, resetting, or aborting another operation.

Record the original branch, HEAD, and intended range. Resolve the configured remote, fetch it once, and pin the target
commit for this operation. Retain a named recovery ref for the original HEAD. Rebase with
`--no-autostash --no-update-refs`; preserve commit boundaries and merge intent; use Git's distinct `--onto` transplant
only when the requested range requires it. Do not rewrite other branches.

Resolve each stopped commit against upstream intent, callers, and tests. Rebase `ours` is the rebased series; `theirs`
is the replayed commit. Avoid wholesale side selection. Follow behavior through renames/deletions; resolve manifests and
sources before regenerating lockfiles or derived output with pinned tools. Inspect reused resolutions, stage only the
resolution, and continue without bypassing gates or skipping unresolved commits.

Stop for incompatible requirements, required human approvals, concurrent edits, or verification failures without a clear
in-scope repair. Preserve resumable state and report the precise decision or failure; never manufacture acknowledgments.

Review the old/new series with `git range-diff`, account for changed or omitted patches, and inspect merge topology
separately. Run applicable project validation and checks; confirm the rebase ended with a clean checkout. Report the
original/final commits, target, material resolutions, verification, and recovery ref. Leave publication to a separate
request.
