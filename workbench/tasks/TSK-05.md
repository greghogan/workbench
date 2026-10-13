---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-5: Unify local and hosted check planning and improve inspection

## Review summary

Local and hosted CI now share target planning and execution adapters. Check inspection is readable, release artifacts
are verified outside the checkout, and rehearsal reports distinguish failed targets from infrastructure failures. All
six requested follow-up refactors are complete. Verification passed 229 root tests and all 49 Linux x64 targets, with a
final four-target rehearsal of the latest source. Detailed evidence follows below.

Hosted platforms, cache restoration, and registry publication remain workbench:TSK-7. No commit, push, or deployment was
performed; implementation and draft ADR review remain pending.

## Progress

- [x] Share local and hosted target planning and inspection.
- [x] Implement Linux rehearsal, reports, and cleanup.
- [x] Complete all 49 configured local targets and regression checks.

## Outcome

Use the same resolved check definitions and target plan for local gates, Linux container rehearsals, and hosted CI.
Present readable check tables with structured output and provenance. Preserve the distinction between full gates and
focused test-role execution.

## Current state

`workbench checks` now presents the resolved execution plan as a table or JSON, including definition sources and
excluded checks. It uses the gate planner, including setup, coverage variants, stages, and environment selection.
`checks run` remains the full local gate; `make test` remains focused test-role execution.

`workbench ci` and `make ci` default to all configured Linux x64 targets, as requested by the human, with explicit root
or target subset selection. The hosted matrix and local catalog share configuration and grouped planning. Native,
runtime compatibility, compiler compatibility, environment, and standalone release execution use shared adapters. Node
and Go compatibility acquisition uses the recorded native verification policy; Python uses uv and Rust uses its separate
minimum-version policy.

Rehearsals snapshot pending files and integrated repositories into private disposable storage under `/tmp`, preserve the
source checkout and index, isolate build identities, and reuse verified XDG tool caches. Dedicated Cargo/rustup and uv
stores avoid home credentials and legacy directory migration. Reports retain source tree digests, plans, per-target
outcomes, coverage evidence, and standalone release packages. Independent targets continue after failures. Native and
managed containers use host networking through a scoped adapter; no emulation is selected.

On 2026-10-10, the complete rehearsal passed all 49 configured Linux x64 targets: eight native gates with standalone
releases, 19 compatibility targets, and 22 managed-environment targets. Reports and all eight release packages remain at
`/tmp/workbench-ci-reports-YFgy6x/reports`. The first complete attempt passed 44 and exposed older LLVM's runtime
package documentation links, missing SDK runtime paths when LLD bypasses managed linker wrappers, and an older system
Python without tar extraction filters. These defects were corrected before the passing complete rerun. Nix and Guix pins
were unchanged.

Regression tests cover selection, inspection, snapshots and index preservation, integrated repositories, acquisition,
bootstrap safety, cache isolation, independent failures, report validation, cleanup, and stale-workspace preservation.
Earlier verification also corrected GPG agent socket limits, uv cache migration, and GCC SDK discovery. The final host
CI-stage gate passed all 219 tests in 47 files, coverage floors, formatting, linting, types, bundle parity, workflow
validation, executable documentation, dependency advisories, and credential checks. Both Debian and Ubuntu passed the
consolidated 15-case bootstrap boundary suite, including sparse logical size. Passing roots retain their release
packages independently of other failures.

A subsequent three-target Go rehearsal verified the final report collector through both container and managed launchers:
native execution retained fresh coverage and test reports, compatibility retained no stale reports, and Nix Docker
retained only its fresh test report. Its rebuilt image also exercised the final authenticated Node bootstrap. Reports
remain at `/tmp/workbench-ci-reports-Z0n32C/reports`. Target evidence excludes unchanged baselines and earlier targets'
reports, including after managed ownership repair. Disposable workspaces, locks, image contexts, and owned Dev
Containers were removed after execution; caches and review evidence were retained.

## Completion boundary

Provide the shared planning boundary used by workbench:TSK-8's separately planned selection of affected roots. That task
owns diff analysis and selection policy; this task owns consistent planning, inspection, and execution.

The real Linux x64 matrix rehearsal and final root gate are complete. GitHub permissions, publication, hosted runner
images, and other native platforms remain workbench:TSK-7's remote verification scope, subject to human implementation
review. No staging, commit, push, publication, or deployment was performed for this task; draft ADR acceptance remains
pending.

## Authorized refactors completed

The human authorized all six recommendations after completion: typed targets with shared phases, a common CI cache
layout, owned rehearsal resources, fixture executables replacing command mocks, validated combined result reports, and
separate download/build caches. These are implemented without changing the declared matrix or environment pins.

Target variants and phase definitions now drive inspection and guest execution. Host, guest, and Dev Container cache
wiring share one layout. A workspace owner controls snapshots, locks, disposable contexts, and container cleanup;
uncertain cleanup retains its resource claim. Fixture executables exercise the real adapters and manifests rather than
mocking every command.

The version-1 result protocol separates target outcomes from infrastructure errors, validates exact selected IDs and
attempt metadata, and records preparation, report, interruption, and cleanup failures. Reports are atomically replaced;
the terminal summary and exit status use the final result after cleanup. Independent targets continue after failures,
including unavailable report destinations. Package download caches are separate from installed dependencies and compiled
outputs; installer edits invalidate compiled outputs without invalidating downloads. Compatibility caches select the
native artifacts needed by their phases.

On 2026-10-10, the refactored full rehearsal passed all 49 configured Linux x64 targets with zero infrastructure errors
and retained eight verified standalone release packages at `/tmp/workbench-ci-reports-gvONW6/reports`. The final root
CI-stage gate passed all 229 tests in 48 files, all coverage floors, formatting, linting, types, bundle parity, workflow
validation, executable documentation, advisories, and credential checks. Focused regressions cover malformed, missing,
duplicate and unexpected results, incomplete container execution, independent failures, partial evidence, atomic report
replacement, and uncertain cleanup ownership.

A subsequent four-target Go rehearsal exercised the final report validation and failure handling through native,
minimum-version, Nix Docker, and Dev Container execution. All four passed with zero infrastructure errors. Reports at
`/tmp/workbench-ci-reports-5ioB5f/reports` confirm that native Go retained coverage and tests, compatibility retained no
stale reports, and both managed targets retained only fresh test evidence. Disposable workspaces, locks, image contexts,
adapters, and owned containers were removed; caches and review evidence were retained. Hosted cache restoration and
other-platform behavior remain workbench:TSK-7's verification scope after human review. No commit, push, publication, or
deployment was performed.
