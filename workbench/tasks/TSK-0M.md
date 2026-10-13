---
status: Active
parent: null
depends_on:
  - workbench:TSK-L
---

# TSK-M: Unify development environments and CI execution

## Review summary

Resume the agreed project-wide environment design after GCC binary integration. Workbench should demonstrate multiple
languages with simple examples and reusable development environments; it should not operate an exhaustive compiler
compatibility service for every example. Preserve both verified host installations and prepared Linux images, with
native, Nix, and Guix owning separate environments. This design is approved in conversation; implementation and concise
draft ADR updates are in progress. After local Linux verification, push a temporary CI branch containing draft records;
their acceptance remains pending human review.

## Progress

- [x] Implement project compiler/runtime profiles shared by local development and CI.
- [x] Prepare project-wide Linux development images and acquire matching published images before building locally.
- [x] Record immutable image inputs and publication history in a JSON catalog, with explicit manual image deletion.
- [x] Simplify the reference CI matrix and remove change detection.
- [x] Verify Linux x64 native, Nix, and Guix execution locally before the next Workbench CI push.
- [x] Reevaluate Workbench commands, configuration, and concise ADR wording for consuming projects.
- [x] Support curated source-map indexes and subsystem maps with automated reference, coverage, and duplicate checks.
- [ ] Push the verified draft to a temporary branch and inspect hosted CI and GHCR results.

## Agreed design

- Native, Nix, and Guix remain independent tool authorities. A consumer normally selects one; Workbench demonstrates all
  three. Managed environment pins remain human-controlled.
- All language and framework examples exercise the selected development versions on Linux x64, Linux ARM64, macOS ARM64,
  and Windows x64. macOS and Windows verify native builds. No emulation is selected implicitly.
- Workbench's own Node runtime support receives its full supported-version matrix. Runtime/compiler selections apply
  locally as well as in CI. The examples do not need exhaustive minimum/latest language matrices or a Rust MSRV job.
- Select Clang or GCC through compiler profiles; LLVM continues to supply formatting and analysis. GCC uses the verified
  Linux binaries adopted by workbench:TSK-L, with downloads as the hosted default and optional retention.
- Native host installations and prepared Linux environments share declarations. Local and hosted persistence choices
  remain explicit; validate the paths we actually provide without repeating every cold/warm combination on every push.
- Nix and Guix CI use retained prepared containers for Workbench and every example. Local Nix/Guix development may use
  host installations. Linux prepared images also support offline development.
- Local preparation and GitHub Actions use the same recipes. Pull the configuration's matching image from the configured
  registry before building when it is absent. Implement GitHub/GHCR first; allow for a future GitLab adapter without
  requiring users to configure both providers.
- Images belong to a project and are not a public dependency for other projects. Their content identities include the
  builder, native architecture, locked tools/dependencies, recipe, and OS repository snapshot. Changing the snapshot
  changes the identity. The checked-out configuration selects the image without promotion.
- Preserve catalog history even after manual image deletion. Catalog entries may carry UTC timestamps to the second and
  the inputs that produced each identity. No automatic image deletion or inferred supersession is required; an old
  deleted image can be rebuilt from its recorded inputs.
- Remove change detection and commit filtering from the reference workflow and CLI. Keep complete configured gates.
  Examples remain independently usable without introducing unnecessary cross-example coordination.

## Implementation

Named tool profiles select versions and compiler families for registered roots, shared by shells, setup, checks, and CI.
The hosted matrix groups all roots and selections into four native platform jobs plus project-wide Nix and Guix jobs.
Prepared profiles use the same Dev Container recipes locally and in CI, with registry-first acquisition, immutable input
hashes, fresh offline verification, and a retained project image catalog. Host caches remain selectable independently.

Source maps now support an architectural index linking subsystem lists or tables. Validation catches missing paths,
uncovered configured source roots, duplicate entries, unsafe paths, and map cycles. Directory entries can own a whole
subsystem; exclusions are explicit. Workbench's source map demonstrates this structure.

Native and Nix images passed fresh offline builds and tests for Workbench and all examples. Verification corrected
package metadata refreshes, a retained Go output cache, and missing retained authentication proofs. Added proof-cache
tests reject missing or corrupted offline evidence.

The canonical Linux rehearsal passed all 40 targets across its full run and one focused retry, including the selected
Node/GCC profiles and release checks. Workbench's three native Node profiles and both managed gates each passed 387
tests. Repairs separated structural validation from active tool profiles, included Nix definitions in release packages,
and isolated Git maintenance and CI selectors in test fixtures. Reports are in
`/tmp/workbench-ci-reports-G9az4M/reports`; `/tmp/workbench-ci-reports-TF3H4P/reports` records the successful Guix root
retry after a transient OSV network failure. No advisory checks were disabled. The passing default native runs also
provide the retained coverage summaries for future comparisons.

The approved Guix repair selects the existing channel's `cmake-minimal@4.3.3` in the C/C++ manifests. Its `cmake`
package still supplies CMake 4.1, which lacks an operation required by the selected vcpkg tooling. Both manifests
document this temporary choice and the condition for switching back to `cmake`. All twelve Guix gates now pass,
including Workbench's 387 tests. Offline verification identified missing `make` and `xz` test prerequisites in the root
manifest; these are now declared. All three images have passed final offline verification. Local verification is
complete; hosted verification is next.

## Remaining verification

Use the locally available Linux x64 host first. GitHub then verifies the other native platforms and real GHCR
publication. ADR acceptance is still pending human review; a temporary CI branch with draft records remains authorized
when ready for remote verification.
