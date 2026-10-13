---
status: Canceled
parent: null
depends_on: []
---

# TSK-1: Complete the pending Workbench adoption and execution work

## Review summary

Retired as a coordination record on 2026-10-11. The task map now supplies the project overview; workbench:TSK-G,
workbench:TSK-I, and workbench:TSK-7 continue independently. The human intends to exclude these development tasks from
the initial commit. The remaining text preserves historical context while implementation continues.

Complete the shared configuration, verified tool acquisition, build/release profiles, CI, and ADR integration work.
Child statuses and links below provide the review overview; each child retains its own plan and evidence. Local Linux
verification, changed-root CI selection, and collection integration are complete. Automatic local and shared project
collection installations passed revised behavioral tests and coverage. Java and JavaScript additions then passed all 13
added Linux x64 targets, the 317-test root gate, and all ten native commit-stage roots. A subsequent runtime refresh
passed 28 selected Linux x64 targets and the 319-test root gate, retaining older API targets. Hosted verification
remains pending. On 2026-10-11 the human approved the portability/cache follow-ups and draft ADR reorganization, and
renewed authorization to use a temporary CI branch before ADR acceptance. Exact-text ADR review and deployment review
remain pending.

## Outcome

Bring the authorized Workbench design, implementation, and verification to a coherent reviewable state. Preserve the
distinction between inherited definitions and project-owned starter copies. Finish the child outcomes before treating
the broader work as complete.

## Current state

As of 2026-10-09, the initial implementation is uncommitted in the primary checkout. ADRs remain drafts pending
exact-text human review. Earlier temporary CI commits were authorized solely to test draft documents and did not accept
them. The 2026-10-11 authorization permits further temporary CI-branch verification before ADR review is complete;
deployment remains pending review.

The earlier local LLVM selection experiment completed its measured baseline and candidate runs; see workbench:EXP-0.
That evidence does not demonstrate the newer production streaming installer or all supported platforms.

## Progress

Each child owns its implementation and verification evidence. Linked checkboxes and status labels are derived from child
status:

- [x] workbench:TSK-2 (Done): Implement complete language configuration inheritance.
- [x] workbench:TSK-3 (Done): Finish authenticated streaming artifact installation and filtered caches.
- [x] workbench:TSK-4 (Done): Complete and verify native release LTO integration.
- [x] workbench:TSK-5 (Done): Unify local and hosted check planning and improve inspection.
- [x] workbench:TSK-6 (Done): Complete development and release profile design and implementations.
- [x] workbench:TSK-A (Done): Apply CPU budgets and concurrent local CI.
- [x] workbench:TSK-B (Done): Refactor CPU allocation and local CI lifecycle.
- [x] workbench:TSK-8 (Done): Select CI roots from changed files and shared dependencies.
- [x] workbench:TSK-9 (Done): Integrate additional pinned ADR sources and private standards.
- [x] workbench:TSK-C (Done): Add Java definitions, checks, verified tooling, and a standalone reference.
- [x] workbench:TSK-D (Done): Add checked JavaScript definitions and a standalone reference.
- [x] workbench:TSK-E (Done): Add Ruby and PHP references with verified tooling and Linux matrix coverage.
- [x] workbench:TSK-F (Done): Review the full project from the consuming-project perspective.
- [x] workbench:TSK-H (Done): Reorganize and shorten draft ADRs after the comprehensive review.
- [x] workbench:TSK-J (Done): Preflight collection selections before changing active pins.

Changed-root selection and the revised collection design are complete and locally verified. Review the implementation
and draft ADRs before the final hosted CI push. Workbench:TSK-7 depends on these tasks; initial hosted verification
still runs the complete matrix explicitly, including roots unchanged in that push.

## Validation

On 2026-10-09, the authorized draft ADR reorder updated 44 decisions and dependent documentation. The ordering audit
found no forward ADR references, and Workbench structural/documentation validation passed for 64 Markdown files. The
old-to-new mapping is retained in `workbench/evidence/adr-order-20261009.json`. These checks do not establish
implementation or hosted-matrix completion.

Subsequent lint cleanup corrected all 11 TypeScript/JavaScript errors, including transfer cancellation ownership. The
complete root commit-stage gate passed on 2026-10-09: formatting, lint, types, bundle parity, structural validation, 143
tests, shell checks, workflow validation, executable README examples, and credential scanning. The pinned actionlint
release needed exact label entries for GitHub's documented Ubuntu 26.04 x64 and arm64 runners; a negative probe
confirmed that unknown labels still fail. This root gate does not establish completion of the remaining child tasks or
hosted CI.

A subsequent lint review strengthened Workbench and the TypeScript and React starters with additional correctness rules,
linting of tool configuration, unused inline-configuration errors, and focused-test rejection in lint and Vitest.
Starter initialization checks confirm that the complete ESLint and Vitest configurations are copied. React also checks
plain TypeScript files alongside TSX. Rust linting explicitly selects every workspace member and target; C/C++ linting
verifies clang-tidy configuration before compilation. Python's all-stable Ruff and strict mypy settings, Go's vet and
all-Staticcheck selection, and the documented C/C++ and Clippy rule exclusions were reviewed.

On 2026-10-09, configured lint checks passed for all six languages, Python type checking passed, and the TypeScript and
React native commit gates passed. Thirty-nine ESLint probes checked correctness diagnostics, focused tests, unused
suppressions, and configuration-file coverage across all three JavaScript/TypeScript projects. Separate probes verified
local focused aliases and parameterized tests fail in Vitest; valid controls and invalid examples verified Ruff, mypy,
Clippy, Go vet, Staticcheck, and both clang-tidy configurations. C/C++ checks used the already installed matching LLVM
23.1.2 explicitly on PATH because the new artifact-cache selection is not installed; that installation remains owned by
workbench:TSK-3. C++ dependency lookup initially failed for fmt and then passed on retry with the same registry baseline
and tool pins. These local Linux x64 results do not establish hosted or other-platform completion.

The subsequent workbench:TSK-3 investigation completed real authenticated filtered LLVM installation for both C and C++,
and both lint checks passed without the earlier LLVM PATH override. Toolchain storage now uses the platform user cache,
with matching vcpkg and CI paths. Existing local installations were explicitly moved without dropping versions.
Authenticated streaming installation, private runtime handling, bounded ordinary extraction, and filtered cache
integration are now complete; see that child task for final verification. Other-platform and hosted execution remain
workbench:TSK-7.

Record focused and complete gate results against the resulting tree. Do not substitute planning, drafted ADRs, or the
older experiment for implemented behavior and passing verification.

On 2026-10-11, the Node/Python runtime refresh passed all 28 selected Linux x64 targets, including compatibility,
managed environments, Dev Containers, and native release verification. Native development uses Node 26.11.1 and Python
3.15.0 while retaining Node 22 and Python 3.11 API targets. pnpm is 12.11.2 and native uv is 0.13.0. The Node examples
select Nix's newest stable Node package without advancing input revisions; Guix retains its newest available packages.
Verification corrected Node bootstrap size bounds and an upstream Dev Container concurrent scratch-file race, with
regressions. All ten native roots passed their applicable gates; the root suite passed 319 tests and coverage floors.
See [runtime refresh evidence](../evidence/runtime-refresh-20261011.json). No push, publication, or ADR acceptance
occurred.
