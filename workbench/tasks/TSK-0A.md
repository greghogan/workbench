---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-A: Apply CPU budgets and concurrent local CI

## Review summary

Configure a shared CPU budget for every language example and use it to bound concurrent local CI jobs. The human
selected four CPUs per job and deferred memory budgeting. Preserve shared downloads with locking and isolate job
workspaces, build outputs, and reports. All 49 Linux x64 CI targets passed with an observed peak of 16 concurrent jobs.
The final root gate passed 242 tests; the changed Nix/Guix packaging paths passed local verification. No push or
publication is authorized.

## Progress

- [x] Validated project configuration and CPU worker controls.
- [x] Isolated CI jobs and bounded concurrent execution.
- [x] Shared tool installation locks and native package-manager cache integration.
- [x] Behavioral verification across languages and managed environments.
- [x] Documentation and changeset review.

## Outcome

Every parallel-capable language build/test tool consumes the assigned CPU budget, and local CI runs independent targets
concurrently within the available CPU count. Keep the configured matrix, coverage requirements, and independent failure
evidence intact.

## Plan

Use project-owned execution configuration, with four CPUs per job by default and an optional lower concurrency ceiling.
Clamp a job's allocation to CPUs available to its coordinator. Pass that allocation through native, compatibility,
Nix/Guix, and Dev Container entry points. Keep ordinary CPU worker budgets distinct from benchd admission and hard CPU
quotas. Keep memory budgeting out of this implementation as requested.

Freeze one source snapshot, create independent copies for selected targets, and bound worker admission by available CPUs
divided by the per-job budget. Share immutable tool installations and download caches with tool/package-manager locking.
Retain per-target logs, reports, failures, and cleanup obligations. Do not stop independent jobs because one fails.

## Findings

The native C/C++ runner had a hardcoded two-worker fallback. Existing local CI used one mutable workspace and
synchronous target loops. Build locks also spanned every target for a root; parallel jobs need distinct checkout
identities as well as separate output paths. Python requires pytest-xdist to distribute tests; the existing pytest-cov
integration supports its workers. Nix/Guix builder concurrency must account for both simultaneous derivations and
workers per derivation.

## Validation

The complete local CI matrix passed all 49 targets: eight native gates with standalone releases, 19 compatibility
targets, and 22 managed-environment targets. All requests carried the four-CPU allocation, and the worker log recorded a
peak of 16 simultaneous jobs on this 64-CPU host. Independent workspaces and build identities avoided cross-target
locks. Disposable workspaces and owned containers were cleaned; reports and shared caches remain.

Focused behavioral tests covered configuration validation, worker propagation, bounded concurrency, independent failure
handling, installation serialization, failed-writer release, and uncertain lock ownership. Changeset review also
corrected Nix's packaging flag syntax. After that correction, the root and all four Go environment targets passed again.
The final root gate passed 242 tests across 51 files and every existing coverage floor.

Nix portable, Guix portable, and Guix Apptainer packages were regenerated and verified outside their source and builder
stores. Their receipts match current Go sources. Earlier artifacts were preserved under
`/tmp/workbench-cpu-release-backups-20261010`. This host required the existing scoped Docker network adapter for Nix
acquisition; artifact runtime verification remained offline.

See [execution guidance](../guides/execution.md) and [verification evidence](../evidence/cpu-budget-20261010.json).
Worker budgets are not hard CPU quotas; memory budgeting remains deferred. Hosted and other-platform verification remain
in workbench:TSK-7. Environment pins were unchanged; nothing was pushed or published.
