---
status: Active
parent: null
depends_on:
  - workbench:TSK-8
  - workbench:TSK-9
  - workbench:TSK-C
  - workbench:TSK-D
  - workbench:TSK-E
  - workbench:TSK-F
  - workbench:TSK-G
  - workbench:TSK-H
  - workbench:TSK-I
  - workbench:TSK-J
---

# TSK-7: Verify the supported hosted matrix, caches, and publication workflows

## Review summary

Verify the hosted OS/architecture matrix, cache restoration, and requested registry publication after changed-root
selection, additional ADR source integration, language additions, and consumer portability. Implement the explicit
publication workflow before testing it: registry publication is currently absent, not merely unverified. The CI push is
the final verification phase. Earlier complete and incremental Linux x64 rehearsals are recorded below. These results do
not establish hosted permissions, registry behavior, or macOS/Windows/ARM64 execution. On 2026-10-11 the human made the
repository public and authorized further testing on `ci/draft-functionality-20261008` or a similarly named temporary
branch before ADR acceptance. Deployment still requires review.

## Progress

- [x] Obtain renewed authorization for temporary CI-branch verification while ADR acceptance remains pending.
- [x] Finish the approved implementation follow-ups and local verification before the next push.
- [ ] Verify the complete hosted OS/architecture and managed-environment matrix.
- [ ] Improve selected Rust and Dev Container tool caches; measure cold/warm runtime, restored bytes, and disk use.
- [ ] Implement an explicitly selected publication workflow and test authorized GitHub Container Registry publication
      and artifact identity.

## Outcome

Demonstrate the provided functionality on the declared native platforms and selected managed environments, with bounded
runtime/storage, useful caches, and explicit publication evidence under its separately reviewed workflow.

## Current state

Earlier draft CI was canceled at human request to stop expensive GCC builds. Prior Nix and several compatibility jobs
passed, while native/Dev Container failures still need hosted verification. No full passing hosted matrix establishes
current behavior. Runner labels have draft Ubuntu 26.04 updates; SDK prerequisites and the Guix bootstrap package still
require verification. Temporary draft-branch testing is authorized by the latest human instruction; document acceptance
and deployment remain separate.

The C/C++ declarations now cover Clang's three-major window (21, 22, 23) and every upstream-maintained GCC branch (14,
15, 16), with exact patch selections. ADR-14 distinguishes this Clang compatibility promise from upstream maintenance.
Verify all declared selections on their configured hosted targets and preserve that distinction during updates. Rust
retains its separately documented minimum-version exception.

On 2026-10-10, authenticated filtered installations and Linux x64 checks passed for Clang 22.1.8 and LLVM 23.1.3 in both
C and C++. The new 22.x compatibility selection passed ordinary tests, sanitizers, portable checks, and off/full/thin
LTO with standalone verification and invalid-configuration rejection. Both complete native CI-stage gates passed with
23.1.3. The root CI-stage gate passed all 194 tests and coverage floors. The generated matrix includes 21.x and 22.x
compatibility targets and uses native 23.x targets without duplication. Other hosted platforms remain unverified.

Subsequently, workbench:TSK-5's complete local rehearsal passed all 49 configured Linux x64 targets: eight native
CI-stage gates with standalone releases, 19 compatibility targets, and 22 managed-environment targets. This includes
Guix, Nix Docker, and Dev Containers for every example, plus Workbench's own Dev Container. The latest root gate passed
219 tests and coverage floors. Real runs corrected older LLVM runtime discovery, GCC's host SDK paths, managed C++ LTO
runtime paths, and the bootstrap on an older system Python. These local results replace the earlier Linux uncertainty;
they do not establish hosted runner, permission, registry, publication, or other-platform behavior. Nix and Guix pins
were unchanged.

The new Guix Dev Container bootstrap in workbench:TSK-6 found that the tested Ubuntu 26.04 package repositories did not
supply Guix. Its new workspace recipe uses pinned Ubuntu 24.04 and a signed-repository Guix package, explicit build-user
group membership, network service definitions, and a UTF-8 locale. Verify the existing hosted 26.04 Guix bootstrap
before asserting hosted support; runner and channel/flake pins were not changed during that task.

The development/release work in workbench:TSK-6 subsequently passed the 239-test root gate, both managed Dev Container
Go gates as ordinary users, and all nine retained release profiles. Its Guix cold runtime build took approximately 20
minutes; verify useful store/channel caching and first-use acquisition without the local authenticated checkout cache.
Workbench:TSK-A completed concurrent local CI and language CPU budgets. All 49 Linux x64 targets passed with four CPUs
per job and an observed peak of 16 jobs on this 64-CPU host. The final root gate passed 242 tests; shared downloads use
installation locking, and targets own separate workspaces and outputs. Memory budgeting remains deferred. See
[CPU verification evidence](../evidence/cpu-budget-20261010.json); hosted results remain pending.

Workbench:TSK-B subsequently completed the six approved execution refactors. The final full Linux x64 matrix passed all
49 targets, the root gate passed 255 tests, and the changed managed package profiles passed verification. Workspace
sampling confirmed the 16-job bound and complete cleanup. A shared pnpm ownership-restoration race found during that
work was corrected and verified. See [refactor evidence](../evidence/execution-refactors-20261010.json).

## Plan

Workbench:TSK-8 and workbench:TSK-9 are complete. Finish the review follow-ups and their local verification before the
next hosted CI push. The human requested this ordering on 2026-10-10 and renewed temporary-branch authorization on
2026-10-11. Use the earlier draft branch or a similarly named successor, explicitly retaining draft document status.
Standard runners in the now-public repository have no minute charges under
[GitHub's billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Feedback time,
runner capacity, disk use, and cache storage still justify the approved efficiency work. Keep deployment authorization
separate.

Inspect and resolve recorded platform failures, complete filtered compiler caches, and bound GCC installation costs.
Verify Python/Node/Go/compiler coverage without duplicating development pins. Run the complete matrix for initial
verification and releases. Workbench:TSK-8 plans changed-root selection for ordinary pushes and pull requests; retain
each selected root's complete matrix and verify that ADR-only changes launch no example jobs. Use the authorized draft
branch for native Linux x64/ARM64, macOS ARM64, Windows x64, managed environments, release smoke tests, and cache
restoration. Test GitHub Container Registry publication through the separately reviewed publication workflow. Report
permission, registry, and hosted OS limitations separately from local Linux results.

Workbench:TSK-8 completed changed-root selection before matrix grouping, unconditional validation, a stable aggregate
status, and optional affected local rehearsal. The final root gate passed 268 tests and coverage floors, and the final
Python-only rehearsal passed all seven Linux x64 targets with cleanup. Synthetic event payloads passed real planning
adapter invocations for affected pushes, documentation-only pushes and pull requests, full verification, and
missing-base fallback. See [selection evidence](../evidence/ci-selection-20261010.json). During hosted verification,
explicitly select the complete matrix and verify empty-group status and branch-protection behavior as separate
affected-change cases.

## Local review branch

`ci/review-functionality-20261010` consolidates the initial draft implementation, affected-root explanation rollups, and
five supporting refactors. The complete Workbench root CI gate passed 273 tests and coverage floors; the separate
complete proposed-tree commit gate passed all eight registered roots. See
[refactor evidence](../evidence/ci-selection-refactors-20261010.json). The earlier published temporary CI branch is
preserved. Draft ADRs and the charter remain pending human review; review receipts are unchanged. No new push or
publication was authorized or performed by that local squash. The 2026-10-11 instruction above renews temporary-branch
authorization. Finish the current review follow-ups before hosted verification.

The Java and JavaScript additions in workbench:TSK-C and workbench:TSK-D passed all 13 new Linux x64 targets, including
native release verification, maintained runtime compatibility, Guix, Nix Docker, and Dev Containers. The complete
configured local matrix then contained 62 targets; the earlier 49-target rehearsal is historical evidence. The root gate
passed 317 tests and coverage floors. New native JDK/Maven metadata covers the supported platform set, but macOS,
Windows, Linux arm64, hosted cache behavior, and publication still require this task. See
[language verification evidence](../evidence/languages-java-javascript-20261010.json).

The subsequent Node/Python runtime refresh passed all 28 selected Linux x64 targets on 2026-10-11, including maintained
runtime lines, managed environments, Dev Containers, and release relocation. The root suite passed 319 tests and
coverage floors; all ten native roots passed their applicable gates. Python now covers 3.11 through 3.15, and Node
covers 22, 24, and 26 while retaining the older static API baselines. Nix's Node examples select its newest stable Node
package without advancing flake revisions. The complete local matrix now contains 63 targets; this refresh did not run
all 63 together. See [runtime refresh evidence](../evidence/runtime-refresh-20261011.json). Hosted verification remains
pending; the later temporary-branch authorization above permits the CI step before ADR acceptance.

## Comprehensive review update

The current catalog contains 76 Linux x64 targets: 12 native, 30 compatibility, and 34 managed targets. Ruby/PHP added
13 passing local targets; their evidence is in [the language report](../evidence/languages-ruby-php-20261011.json).
Those incremental results do not constitute a fresh full 76-target run. The review corrected hosted Ruby/PHP dispatch
that previously skipped its adapter, and found the older Guix bootstrap command still selected on Ubuntu 26.04. Resolve
that bootstrap before a hosted run. Measure both cold and warm runtime/storage, including Dev Container compiler/runtime
caches, Rust toolchains, and uncached managed stores. No push or publication was performed during the review.

The human approved the cache follow-up on 2026-10-11. Start with selected Rust installations and the missing Dev
Container toolchain paths, keeping tool verification and lock identities intact. Compare installation savings with cache
upload/restore time and bytes. Prefer substitutes and selected installations over entire managed stores; add broader
caches only when measurements justify them. Public CI removes the minute concern without changing the full matrix for
each affected root or the requirement to run checks after cache restoration.

## Shared installation verification handoff

Workbench:TSK-G passed all 76 Linux x64 targets. Workbench:TSK-I passed the 366-test root gate, staged-pin and update
checks, a real read-only shared-installation Dev Container, both independent consumer local CI targets with release
verification, and a two-user system-store privilege test. Verify native Windows DACLs and macOS/Linux arm64 behavior in
this hosted phase. The original checkout index remains unchanged.

## Current implementation

Selected Rust toolchains now have isolated, version-specific caches. Dev Container caches cover the selected guest tool
versions, including filtered LLVM and managed Python. Jobs retain cache footprint and elapsed-window measurements. The
Guix job uses Ubuntu 24.04 for its signed bootstrap package while other Linux jobs retain Ubuntu 26.04; project channel
and flake pins are unchanged.

A separate publication workflow verifies prepared Nix/Guix images before publishing unique CI tags, then pulls by digest
and checks image identity and offline behavior. It is selected manually or through an explicitly named publication
verification branch before the initial default-branch commit. Routine checks remain read-only. No deployment is
included. Focused checks pass all 25 tests across cache planning, publication boundaries, and native installation;
workflow lint passes. The full local gate passes all 370 tests and 13 configured checks. Review of the previous hosted
logs identified Windows long-path checkout and Git Bash linker selection failures; the preflight now enables long paths
and selects the MSVC linker explicitly. Focused vcpkg verification, type checking, and workflow lint pass after those
corrections.

The first hosted full run is [38114097093](https://github.com/greghogan/workbench/actions/runs/38114097093) on
`ci/draft-functionality-20261011`; draft documents remain unaccepted. Nix Docker, maintained runtime checks except one
rate-limited Python acquisition, Clang compatibility, and all six Linux x64/ARM64 GCC selections pass. Native platform
failures exposed unauthenticated GitHub API limits, Git Bash GnuPG path interpretation, missing guest decompressors,
Linux-x64 assumptions in test fixtures, lost Git revision metadata under coverage, and incomplete Ruby platform locks.
The Windows signature repair passes its dedicated hosted diagnostic. Follow-up full platform verification is pending.
The repaired local C Dev Container gate passes; the latest complete root gate passes 372 tests and all 13 checks.

Cache measurements retain compressed GitHub inventory separately from uncompressed per-job footprints. The first partial
run reached approximately 9.2 GB across 65 caches; complete cold/warm comparison and eviction behavior remain pending.
Publication now requires a successful Checks run for the exact revision and its retained plan covering every configured
root. No registry publication or deployment has occurred.

A disposable GCC 16.2 installation shrank from 1,977,915,609 to 289,239,129 file bytes after removing debug information;
C17/C++20 LTO and sanitizer probes pass. The source installer now selects upstream `install-strip`, with recipe and host
ABI in its installation identity. Ruby's full configured Linux gate passes with external dependency storage. A separate
standalone Ruby coverage defect counts installed gems under the source root; changing that scope awaits the human
approval required by ADR-A.
