---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-8: Select CI roots from changed files and shared dependencies

## Review summary

Implemented changed-root selection before CI job grouping, preserving every selected root's complete matrix. ADR-only
changes run validation and documentation checks without example jobs; unknown inputs and unavailable history select the
full matrix. Local rehearsal uses the same resolver. GitHub workflow comments and spacing now explain each execution
phase. Local verification is recorded below; hosted verification remains workbench:TSK-7, and the draft ADR
clarification still requires human review before commit.

The subsequent five refactors reduce compact-report allocations, separate explanation identities from wording, test
public scheduler forwarding, distinguish expected comparison failures from implementation faults, and reject
contradictory hosted plans. Dependency explanations retain every applicable immediate cause without changing selection.

## Progress

- [x] Define changed-root policy and shared-input dependencies.
- [x] Implement conservative diff-based root selection.
- [x] Verify ADR-only changes select no example jobs and shared changes expand the selection.
- [x] Preserve complete selected matrices and stable aggregate status.

## Outcome

Select CI check roots from the changed files and their declared dependencies, reducing unnecessary example jobs while
running each affected root's complete configured platform, environment, compatibility, coverage, and release checks.
ADR-only changes run record, reference, generated-context, and documentation validation without any example jobs.

## Current state

The human requested this optimization on 2026-10-09, refining the earlier choice to run every root's full matrix on
every push. Full configured matrices remain required for selected roots. At task start, CI planned every root and
grouped compatible jobs without dependency-aware selection. Shared planning and local rehearsal remain owned by
workbench:TSK-5; hosted verification remains owned by workbench:TSK-7.

Draft ADR-10 now permits CI root selection while retaining complete suites inside each selected root and the complete
local proposed-tree commit gate. `src/ci-selection.ts` owns comparisons, the compiled dependency graph, conservative
fallback, and grouped selection reports. `src/ci-inputs.ts` reads cached revision inputs through shared configuration
and language parsers. It reads both revisions without executing historical code or fetching history. Dependencies
propagate through affected roots; cycles terminate without losing selected work. Workbench submodule definitions resolve
at their recorded revisions, while shared language definitions ignored by local replacements are not parsed.

The hosted planner passes event revisions through structured command arguments. It compares pushes against the previous
pushed revision and pull requests against their merge base. Manual full runs, tags, and release verification select all
roots. Empty groups do not create matrix jobs; unconditional validation and the stable aggregate status still run.
Selected-job failures, cancellation, unexpected skips, or validation failures cannot yield aggregate success. Selection
summaries include roots, grouped reasons, changed-file counts, and revisions. Individual filenames are available with
`--explain-files`; explanation size does not expand the selected matrix. Uncertain comparison inputs still select all
roots.

Optional local comparison uses `workbench ci --affected --base REVISION`, including staged, unstaged, and nonignored
untracked changes unless `--head` is supplied. `make ci BASE=REVISION` delegates to it. Empty selections validate
without acquiring example tools, dependency caches, containers, or job workspaces. Default local rehearsal still covers
all Linux x64 targets. No Guix/Nix pins changed and no push or publication occurred.

## Design

- Always run a small validation job and a stable aggregate status, including when no example root is selected.
- Classify ADRs, charters, record maps, tasks, record-allocation metadata, and derived agent context as documentation
  inputs. Changes confined to these files select validation and documentation checks, with no example jobs. Coupled
  executable or configuration changes still select their affected roots normally.
- Changes within an example select that example. Changes to a shared language definition, adapter, filter, pin, or
  environment definition select every root that uses it. Shared CLI, installer, bundle, CI orchestration, and global
  configuration changes conservatively select all potentially affected roots. Unclassified changes select all roots
  until their ownership is established; documentation paths have explicit classifications rather than falling into that
  fallback.
- Resolve the affected roots before grouping matrix jobs. Retain every configured target for those roots, then omit
  empty groups. Do not pass changed filenames to test runners or filter tests within a selected suite.
- Express additional consuming-project dependencies in declarative configuration, with provenance and reasons for each
  selection. Use the same resolver for hosted CI and optional local rehearsal of affected roots.
- Compare pull requests against the appropriate merge base and pushes against the previous pushed revision. Include
  added, deleted, renamed, and type-changed paths, using both sides of renames. Account for changed dependency
  declarations in both revisions. Missing history, unsupported events, and uncertain analysis select the full matrix.
- Provide an explicit full-run option; releases and initial verification run all configured roots. Report the compared
  revisions, selected roots, excluded roots, and reasons in readable and structured output.

## Verification plan

Use isolated repositories to demonstrate ADR-only changes select no example jobs, a Python-only change selects only
Python, and language definitions and shared executable changes select their dependents. Cover documentation changes
alongside code changes, deleted dependencies, cross-root renames, new roots, empty selections, merge commits, new
branches, force pushes, unavailable bases, and full-run overrides. Verify required status behavior without hiding
selected-job failures or leaving an intentionally empty matrix pending. Confirm unaffected roots acquire no tools,
dependencies, or cache entries. Rehearse locally before hosted execution; no push or publication is authorized here.

## References

- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): event
  comparisons, changed-path limitations, and pending checks when whole workflows are skipped with path filters.
- [pre-commit configuration](https://pre-commit.com/#pre-commit-configyaml---hooks): file selection and
  `pass_filenames`, illustrating the distinction between selecting a check and restricting its input files.

## Verification

Thirteen selector/status regressions cover documentation-only and mixed changes, staged/unstaged/untracked inputs,
selected language definitions and local replacements, shared adapters, declared and transitive dependencies, removed
edges, dependency cycles, renames and deletions, Git status parsing, merge bases, merge commits, non-ancestor pushes,
new roots, unavailable history, invalid declarations, full overrides, pinned distribution submodules, complete matrix
projection, empty groups, aggregate failures, and a real empty local run. Existing lifecycle execution tests retain
their isolation, cleanup, interruption, and failure assertions with the new root-selection boundary represented in
fixtures.

An isolated disposable checkout demonstrated documentation-only selection with zero example roots, Python-only selection
with all seven configured Linux x64 Python targets, and the unchanged 49-target full Linux catalog. The final Python
rehearsal passed all seven targets, including native release verification, three compatibility interpreters, Guix, Nix
Docker, and Dev Container. No other roots were admitted. Real hosted planning-adapter invocations with synthetic event
payloads verified Python pushes, documentation-only pushes and pull requests, explicit full verification, and new
branch/missing-base fallback. These are local rehearsals; GitHub runner execution and branch-protection integration
remain workbench:TSK-7.

See [selection verification evidence](../evidence/ci-selection-20261010.json) for the final root gate, coverage,
selected target results, and event planning outcomes. The full 49-target execution baseline remains workbench:TSK-B's
evidence; this task reran affected Python targets and the complete Workbench root gate rather than claiming a new
full-matrix run.

The final complete root CI-stage gate passed all 268 tests across 56 files and every configured coverage floor.
Formatting, lint, types, bundle/license parity, structural validation, shell checks, actionlint, executable
documentation, dependency advisories, and credential scanning passed. Coverage was 88.65% lines, 82.82% statements,
90.43% functions, and 75.85% branches. The final affected Python run passed 7/7 targets with zero infrastructure errors
and no remaining job workspaces, source snapshot, or coordinator lock.

## Selection refactors

The human requested grouped explanations and five supporting refactors after the initial verification. Selection now
matches roots and declared dependencies to changed files, reporting one reason and count per matching group. The normal
report omits filename lists; `--explain-files` includes the changed paths and each group's matching files. Explanation
size never changes which roots run. The report keeps version 1; callers move directly to its current shape without
compatibility adapters, as requested before any installations exist.

Current and historical declarations share configuration, registry, source-selection, and language-automation parsers.
Each revision caches file reads and reads each selected language once. Both revisions contribute dependency edges to a
compiled graph, traversed with a queue. CI commands share comparison options and argument serialization. Hosted planning
validates its output contract; aggregate status has an explicit entry point and validates incoming data. Policy,
Git-history, hosted-adapter, and CLI-execution tests have separate suites, with common source-copy exclusions for
isolated coverage and execution fixtures.

## Refactor verification

All 273 Workbench tests passed across 59 files in the complete root CI gate, including 18 selection and hosted-planning
regressions. Coverage passed every configured floor: 88.86% lines, 83.06% statements, 90.52% functions, and 76.06%
branches. The separate complete proposed-tree commit gate passed all eight registered roots, including native C/C++ LTO
and sanitizer checks. The 49-target Linux catalog and hosted group counts remain unchanged; this verification does not
claim a new execution of all 49 environment and compatibility targets.

A real 3,000-file Git comparison produced a detailed report larger than 256 KiB while retaining only the Python root.
Compact and detailed reports selected the same roots. Real hosted-adapter invocation passed manual full planning and
aggregate status without implying a diff was inspected. Importing the status module does not execute it, and malformed
plans fail with diagnostics. The normal report keeps filenames out of GitHub matrix output.

See [refactor verification evidence](../evidence/ci-selection-refactors-20261010.json). The local review branch is
`ci/review-functionality-20261010`; it consolidates the initial draft implementation and these refactors. Draft ADR and
charter acceptance remains pending under the earlier temporary CI authorization. Review receipts are unchanged. No push
or publication occurred.

## Selection follow-up

Match groups now own one count and retain filenames only for detailed reports. Roots share those groups instead of
copying filename sets. Structured reason identities preserve dependency provenance independently of display wording.
Queue membership is separate from recorded causes: directly selected roots still receive applicable dependency reasons,
multiple declarations remain distinguishable by their paths, and cycles admit each root once.

Shared validators mark invalid caller-owned input explicitly. Expected history, declaration, changed-path, and checkout
failures retain operation context and their cause while selecting the complete matrix. Unexpected parser and selection
errors fail planning visibly. Hosted validation checks the workflow's matrix fields, selected/excluded identities,
matrix membership, and detailed filename/count consistency before scheduling jobs.

The public CLI execution regression runs the real forwarded command through an isolated hold/follow scheduler fixture. A
diverged base branch and dirty Python input distinguish correct forwarding of both merge-base and committed-head
selection; the empty result validates without acquiring example tools, caches, containers, or workspaces.

The follow-up root CI gate passed all 276 tests across 59 files, including 21 selection and hosted-planning regressions.
Every configured coverage floor passed: 88.97% lines, 83.21% statements, 90.81% functions, and 76.27% branches. The
separate complete commit gate passed all eight registered roots, including C/C++ LTO and sanitizers. Real hosted-adapter
invocations verified full planning and missing-history fallback; the catalog remains 49 Linux x64 targets with unchanged
hosted grouping. This does not claim a new full-matrix execution or hosted verification.

See [follow-up verification evidence](../evidence/ci-selection-followup-20261010.json). The implementation remains on
the local review branch, with draft ADR and charter acceptance pending and review receipts unchanged. Nothing was pushed
or published.
