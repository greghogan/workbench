# Comprehensive project review — 2026-10-11

## Review summary

Workbench's record model is coherent and usable independently of its language/build tooling. The strongest parts are
explicit ownership, namespaced records, complete local language replacement, immutable collection verification, staged
commit gates, and isolated updates. The main readiness gaps are reusable language automation that still assumes the
reference applications, unfinished hosted publication, the hosted Guix bootstrap, and unmeasured cold/warm CI costs.
This review fixes concrete defects and records those remaining boundaries without claiming a verified release.

The review covers all major implementation areas, public command families, ten language examples and React, acquisition,
profiles, CI selection/execution, and documentation. It combines source inspection, existing evidence, regression tests,
and fresh local verification. It does not constitute execution on every declared platform or a security audit of
upstream package managers. No skill, commit, push, publication, dependency update, or ADR acceptance was part of this
review.

## Findings corrected

| Priority | Defect and consequence                                                                                                                                                | Correction                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | The public launcher selected its own distribution directory as the project, so invoking a shared executable from another checkout could edit the wrong records.       | Discover the project from cwd, preserving explicit snapshot roots. Test nested consumer invocation and explicit root selection.                                                                                         |
| High     | Distribution packaging recursively deleted the configured output before validation; a mistaken output could be the source records or checkout.                        | Restrict in-checkout output to `dist/`, reject symlink traversal and unowned destinations, stage privately, and replace owned output after successful preparation. Preserve prior output and recovery data on failures. |
| High     | Hosted Ruby/PHP compatibility jobs had matrix entries but their execution step was excluded by its condition.                                                         | Dispatch every non-Python/non-compiler runtime through the compatibility adapter; verify that each configured target reaches every required workflow phase.                                                             |
| High     | Generic CI release verification invoked the reference applications' sample API assertions for consumers.                                                              | Invoke a project-owned `release-verify` check. Workbench explicitly registers its sample verifier for each example; a missing or failed verifier fails the release phase.                                               |
| Medium   | Task parent cycles and dependency cycles were checked independently, allowing a child to wait on a parent that must wait on that child.                               | Validate the combined completion graph, including indirect deadlocks, while permitting sibling ordering.                                                                                                                |
| Medium   | Two language suites at one root could produce duplicate check names.                                                                                                  | Include both language and root in shared check identities; verify that both suites' commands execute.                                                                                                                   |
| Medium   | Starter copies decoded every file as text and lost executable permissions.                                                                                            | Copy bytes and preserve executable mode subject to the user's umask. Test binary assets and executable starters.                                                                                                        |
| Medium   | Malformed release fields could be accepted; string `yanked` values could silently remove a release from its index. Citation/release IDs could name a different owner. | Validate mapping keys, extension tables, real dates, Boolean status, artifact filenames/URLs, and owning identities. Preserve declared extensions on creation.                                                          |
| Medium   | Selective collection exports declared every installed shared collection as a dependency, including unrelated private standards.                                       | Include referenced collections and their transitive dependencies. Continue rejecting exports that actually disclose private dependencies.                                                                               |
| Medium   | Citation metadata had no response bound/deadline and could write incomplete generated records.                                                                        | Bound metadata to 1 MiB, bound HTTPS chains to five minutes, cancel failed reads, and validate retrieved metadata before writing records. PDFs retain their 256 MiB limit.                                              |
| Medium   | Feedback resolutions could not reference applicable collection ADRs, despite browsing supporting them.                                                                | Use the integrated record resolver and reject unknown provider decisions before changing feedback state.                                                                                                                |
| Low      | Starter help claimed only TypeScript was supported; the README mixed nearly 1,400 lines of unrelated workflows.                                                       | Correct help, preserve the ownership table, and move detailed procedures into focused guides. Correct stale example counts and task completion descriptions.                                                            |

Relevant implementation: [launcher](../../bin/workbench.mjs), [package output](../../scripts/package-output.mjs),
[hosted workflow](../../.github/workflows/checks.yml), [CI runner](../../scripts/ci-run.mjs),
[records](../../src/records.ts), [release schema](../../src/releases.ts),
[collection export](../../src/collection-commands.ts), and
[consumer regressions](../../tests/consumer_regressions.test.mjs).

## Remaining findings, in suggested order

### 1. High: reusable automation still assumes the reference project

The release-verification dispatch is now project-owned, but shared adapters still contain `count`, `count.jar`,
`workbench-ruby-reference-0.1.0.gem`, and `workbench-php-reference.zip`. C/C++ coverage also assumes particular
executable names. Compatibility execution directly selects pytest, Maven, Minitest, PHPUnit, Cargo, Go tests, or a Node
package script; a complete local language replacement does not replace these compatibility commands. A project that uses
another test runner or package layout cannot consistently exercise its own contract without changing the distribution.

This is the largest remaining consumer-facing implementation issue. Decide whether shared adapters become generic, or
reference-specific adapters move into copied starters. Put compatibility setup/test declarations in the selected
language definition, keeping runtime selection separate from the command. Verify using consumers with different
names/layouts, not only the provided count/sum examples. Tracked as [TSK-G](../tasks/TSK-0G.md).

### 2. High: hosted verification and publication are unfinished

The only hosted workflow is the check matrix. Requested GHCR publication has no implemented workflow, so this is more
than missing verification. The Guix environment job selects Ubuntu 26.04 while installing the older
`guix=1.4.0-6build1`; earlier local evidence already found that the tested 26.04 repositories did not supply Guix. The
managed Guix Dev Container has a separately verified 24.04 bootstrap that can inform the fix. Runtime/channel/flake pins
were not changed during this review.

The catalog currently describes 115 target/root combinations: 45 native, 36 compatibility, 22 Guix/Nix Docker, and 12
Dev Container targets. Grouping yields 31 execution jobs, plus planning, validation, and aggregate status. Local Linux
x64 selection contains 76 targets: 12 native, 30 compatibility, and 34 managed. Previous complete and incremental runs
are useful evidence, but the entire current 76-target catalog has not been rerun together, nor has the full current
hosted matrix passed. Windows x64, macOS arm64, Linux arm64, hosted permissions, and registry behavior remain open in
[TSK-7](../tasks/TSK-07.md). Initial hosted verification must explicitly select the full matrix after review.

### 3. Medium: cold CI remains expensive and caching has specific omissions

Changed-root planning is conservative and well covered: it reads both revisions as data, handles renames/deletions,
selects before grouping, falls back when comparison inputs are unavailable, and keeps stable validation/status jobs.
ADR-only changes can avoid every example job. Commit hooks intentionally retain full proposed-tree checks.

Native caches separate downloads, installed dependencies, and authenticated toolchains. Filtered LLVM and compiled GCC
have independent installation identities and save after verification. Grouped roots avoid reinstalling the same compiler
within a job. These are useful optimizations without weakening checks.

Remaining costs: GCC still builds from source on a cold installation; native Rust toolchains are not cached with the
Cargo registry; Dev Container tool-cache selection retains Node and Ruby/PHP runtime directories but not its complete
compiler/interpreter set; Docker build layers and Nix/Guix stores are not persisted by this workflow. Guix's cached
checkout/authentication history is not a substitute store. Existing local Guix evidence includes a roughly 20-minute
cold runtime build. Exact immutable cache keys also retain the first snapshot for a key, so compiled caches do not keep
refreshing after every source edit.

Measure cold and warm runs, bytes uploaded/restored, cache eviction, and peak disk use before adding broad caches.
Prefer selected runtime/compiler caches and useful substitutes over archiving complete stores. Keep full version
coverage for each affected root, as requested. No runner-minute or billing savings are claimed without hosted
measurements.

### 4. Medium: collection installation verifies bytes before selection, but does not preflight every applicable policy graph

Individual inventories, schemas, maps, hashes, and path bounds are verified before installation; immutable content and
registry updates are protected by locks. Cross-collection dependencies, namespace collisions, scopes, and decision
cycles are checked when resolving project context. Installing a new local selection can therefore make subsequent
project validation fail. Existing valid revisions remain on disk, but selection recovery is a manual reinstall of the
intended revision.

Consider preflighting the resulting selection for the current project, with a clear diagnostic before selecting it.
System/user installation can affect multiple projects that cannot all be discovered in advance, so installation-time
validation must not claim global compatibility. An explicit multi-collection transaction or documented dependency-first
installation would improve recovery. Keep the two current applicability cases; no additional activation step is needed.

### 5. Medium: the consumer distribution includes development and historical material

The compressed runnable bundles are small and self-contained, with no production source maps. The packaging script also
ships `src/`, `tests/`, all examples, and Workbench's own task/experiment/evidence history. These records are correctly
excluded from consumer record inheritance, but still occupy storage. The source-map validation contract currently
expects much of this material, so deleting it from packaging alone would break the runnable distribution's validation.

Decide whether to provide a consumer-focused package alongside a full source/reference checkout. Keep shared ADRs,
selected language definitions, required adapters, keys/licenses, and starter assets; define how validation behaves when
development source maps/tests are omitted. Do not duplicate package variants until their intended workflows are clear. A
relocated draft distribution measured 3,718,995 logical bytes (3.55 MiB), including 455,452 bytes (445 KiB) under
`bundle/`. Examples contributed about 0.93 MiB, source and tests together 1.11 MiB, and `workbench/` about 0.47 MiB. See
[the size inventory](project-review-distribution-20261011.json). These are measured snapshot sizes, not filesystem block
usage or a compressed archive size. The distribution contract was not reduced implicitly.

## Record and CLI assessment

- **Ownership and inheritance:** shared ADR integration, complete language replacement, and copied starter ownership are
  distinct and implemented. Charters and task/experiment/environment/citation/release histories stay project-owned. Do
  not introduce field-wise language merging or silently import Workbench's history.
- **Record workflows:** scoped creation, literal search, JSON inspection, retained historical IDs, map synchronization,
  parent/dependency references, and draft metadata are useful. Editing task status remains a file operation followed by
  `sync`; ordinary checklist items are author-maintained, while explicitly linked child entries synchronize status.
- **Experiments and citations:** protocols remain deliberate records rather than commands that execute themselves.
  Citation import/acquisition checks provenance and preserves intervening edits; incomplete metadata now fails earlier.
- **Human review:** receipts bind staged protected content and stay in Git-local state. They are cooperative evidence,
  not signatures. No approval receipt was created or changed by this review, and drafts remain unaccepted.
- **Updates:** isolated preparation, complete scope migration, dirty-tree refusal, ownership checks, rollback, and
  recovery paths are covered by integration tests. Automatic updates currently require a `.workbench` Git submodule;
  vendored copies use manual source management, which the guide now keeps visible.
- **CLI:** record commands, `checks` inspection, explicit roles/stages, profile selection, and release defaults are
  coherent. `checks run` is the local gate; `ci` rehearses declared Linux targets. `release` covers both record
  operations and preparation profiles, so documentation should continue explaining those distinct operations.
- **Ergonomics:** `language` is verbose, and `workbench help --all` exposes many commands. A concise language table/JSON
  mode is a useful later improvement, but adding more management subcommands would not currently improve the file-first
  model.

## Examples and implementation assessment

Ten language examples plus React cover strict analysis, tests, compatibility baselines, locked dependencies, managed
local environments, standalone Makefiles, and release behavior. React appropriately limits its matrix to Linux x64 while
retaining native, Guix, Nix Docker, and Dev Container execution. Runtime compatibility remains separate from current
development tools; Rust retains its explicit exception.

The examples are executable specifications, but are still small applications with closely related APIs. The missing
consumer tests described above matter more now than another sample language. `language init` provides five starters
(TypeScript, JavaScript, Java, Ruby, PHP); other examples and managed environments require explicit
copying/registration. Starter native declarations and lint rules become project-owned. Do not imply that copying one
starter imports a complete managed environment or a universal build adapter.

The acquisition implementation has clear trust identities, bounded extraction, path/link checks, private staging,
authenticated upstream artifacts where available, streaming digest handling, and cache verification. Dependency managers
retain resolution and lock ownership. Runtime source builders, compatibility dispatch, and CI orchestration are among
the most complex parts; keep their behavior centralized and test observable boundaries. Existing focused tests cover
interruption/draining, locks, failed downloads, archive traversal/limits, cache ownership, and stale-report exclusion.
This review did not repeat every upstream artifact download or native compiler build.

## ADR organization for human review

The current 48 draft ADRs already express the ownership model. Keep the charter/authority and record model early, shared
engineering constraints before specializations, and build preparation before release records. Do not add a separate ADR
for React or each procedural CLI choice.

A small reorder would make all language ADRs contiguous without moving the established language IDs:

| Current                       | Proposed | Reason                                                                                                |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| ADR-18, installed collections | ADR-L    | Fill the unused position after shared storage/trust policies; its explicit prerequisites are earlier. |
| ADR-19, Java                  | ADR-17   | Follow Go and the existing language group.                                                            |
| ADR-1A, JavaScript            | ADR-18   | Continue the language group.                                                                          |
| ADR-1B, Ruby                  | ADR-19   | Continue the language group.                                                                          |
| ADR-1C, PHP                   | ADR-1A   | End the language group.                                                                               |
| ADR-17, AWS                   | ADR-1B   | Move the unrelated provider specialization after languages.                                           |

This is a proposal, not a renumbering performed by this review. Apply the mapping simultaneously, update current
references and generated context, preserve historical evidence's original identities, and rerun the no-forward-reference
validation. The earlier mapping remains historical evidence. Keep benchd's exported `benchd:ADR-0` separate.

The main candidates for shortening are ADR-18 (about 719 words), ADR-9 (707), ADR-10 (593), ADR-I (541), and ADR-O
(510). Retain ownership, trust, supported boundaries, failure behavior, and required verification. Move directory
recipes, inventory maintenance procedures, cache details, and exact platform mechanics into the guides or executable
configuration. New language ADRs are already about 150–315 words; their procedural acquisition paragraphs could become
short references to common policy. Shorter policy should not remove the compatibility or verification requirements.

## Verification

The complete root CI gate passed on native Linux x64 with Node 26.11.1: **343 tests in 64 files**, formatting, lint,
types, bundle parity/licenses, structural validation, shell checks, actionlint, the executable README example, OSV
advisories for 261 locked identities, and credential scanning. Coverage floors passed: lines **89.53%**, statements
**84.52%**, functions **90.48%**, and branches **77.19%**. The scheduled gate took about 166 seconds locally; this does
not predict hosted runner time. No committed coverage baseline exists yet, so percentage changes remain unavailable.

The TypeScript reference passed real release packaging and its project-owned `release-verify` check outside the
checkout. A privately packaged Workbench distribution also passed relocated validation. The new tests exercise consumer
launcher routing, starter bytes/modes, overlapping language suites, task deadlocks, release/citation identities and
extensions, package safety, collection export dependencies, collection references from feedback, citation response
limits, and every configured hosted compatibility phase. Existing update, proposed-tree, collection, CI
lifecycle/selection, and acquisition tests also passed.

[Machine-readable verification](project-review-verification-20261011.json) records the implementation digest and gate
identity; [distribution measurements](project-review-distribution-20261011.json) retain the size breakdown. Initial test
runs exposed fixture and source-map omissions, which were corrected; the final gate passed. The complete current example
matrix and other native platforms were not rerun in this review. Hosted checks and publication remain unverified. No
commit, push, dependency-pin change, or ADR acceptance occurred.
