---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-B: Refactor CPU allocation and local CI lifecycle

## Review summary

Implement the six human-approved refactors following workbench:TSK-A: one local CI shutdown lifecycle, workspaces
created and released with admission, complete worker request validation, cache error preservation and separate-process
verification, managed-builder CPU argument helpers, and pure CPU allocation. Preserve the agreed four-CPU default,
independent target outcomes, shared locked caches, and recovery obligations. All 49 Linux x64 targets passed, with 255
root tests and all coverage floors. Three managed package profiles passed verification. No push, deployment,
publication, or environment-pin changes were performed.

## Progress

- [x] Separate CPU allocation policy and consolidate managed-builder arguments.
- [x] Preserve cache installation and release failures; exercise separate-process contention.
- [x] Validate coordinator and worker requests with one contract.
- [x] Cover preparation, admission, draining, and cleanup with one shutdown lifecycle.
- [x] Create and release workspaces per admitted job.
- [x] Focused tests, complete local CI, packaging verification, and changeset review.

## Plan

Use asynchronous preparation commands and filesystem operations so signal handling remains responsive. Stop admission on
interruption and retain admitted mutations until they finish. Release completed job containers and workspaces before
admitting the next job in that worker slot. Preserve uncertain resources and the coordinator lock for recovery. Keep
reports and shared caches after cleanup.

Validate the entire private process request before executing commands. Keep runtime and TypeScript contracts aligned.
Reuse tested Nix/Guix argument constructors, with an independent helper in the standalone Go example. Separate pure CPU
allocation from host/config discovery. Preserve installation and lock-release failures together and verify exclusion
between synchronous and asynchronous installers in separate processes without assuming FIFO ordering.

## Findings

The previous coordinator copied every selected workspace before starting the pool. Signal handlers covered only the
pool, and synchronous preparation blocked event delivery. Cache cleanup could mask an installation failure. Nix and Guix
require different CPU flag syntax; repeated construction had already caused a corrected packaging failure.

Changeset review also corrected failed-log-sink draining. The first complete run passed 48 targets and exposed a shared
pnpm cache ownership race after React's Nix checks passed: another job removed temporary SQLite files during recursive
ownership restoration. The fix restores shared cache ownership within the managed shell, skips disappeared child
entries, and still rejects missing cache roots, permission errors, and other I/O failures. Symlink entries are not
traversed. A regression verifies these boundaries and the actual inline command invocation.

## Outcome

Complete the approved refactors with the existing execution policy, bounded workspace ownership, useful diagnostics, and
behavioral evidence for normal, interrupted, and failed execution.

## Validation

The final complete local rehearsal passed all 49 targets: eight native CI-stage gates with standalone releases, 19
compatibility targets, and 22 managed-environment targets. Every worker request used the validated contract and four-CPU
allocation. Logs recorded 16 concurrent jobs; filesystem sampling recorded at most 16 job workspaces, with none left and
no coordinator lock after cleanup.

The root gate passed 255 tests across 55 files and all existing coverage floors. Type checking, strict linting, bundle
parity, formatting, structural validation, and standalone release checks passed. Focused tests cover pure CPU planning,
builder syntax, separate-process locking, combined failures, request rejection before effects, interruption across the
full lifecycle, bounded workspace ownership, recovery, and logging/cache cleanup failures.

Nix portable, Guix portable, and Guix Apptainer artifacts were regenerated and verified outside the source and builder
stores. Their receipts match the current Go source. Earlier accepted artifacts remain under
`/tmp/workbench-six-refactors-release-backups-20261010`. Acquisition reused the scoped Docker network adapter for this
host; artifact runtime verification remained offline.

See [verification evidence](../evidence/execution-refactors-20261010.json) and
[execution guidance](../guides/execution.md). Memory budgeting remains deferred; CPU workers remain budgets rather than
hard quotas. Hosted and other-platform verification remains in workbench:TSK-7. No environment pins changed; nothing was
pushed, deployed, or published.
