---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-9: Integrate additional pinned ADR sources and private standards

## Review summary

Implemented independently maintained ADR collections, including private organizational standards. Local system, user,
and checkout installations apply automatically; tracked shared project installations carry verified contents and pins
for every contributor and CI. The revised design passed all 31 collection regressions, the full root CI gate with
coverage, and the complete native commit-stage gate for eight roots on Linux x64. See
[revised verification evidence](../evidence/collection-applicability-20261010.json). Exact-text ADR acceptance and
hosted verification remain pending human review and workbench:TSK-7. Benchd application installer integration belongs to
its future Workbench adoption.

## Progress

- [x] Implement verified manifests, inventories, immutable revisions, and scoped ADR integration.
- [x] Move the scheduling policy into the first collection at benchd:ADR-0.
- [x] Draft the revised local and shared project installation design.
- [x] Implement automatic local selection and tracked shared project installation.
- [x] Separate dynamic local agent context from portable shared maps and instructions.
- [x] Keep optional benchd and other local collections outside shared dependencies and release exports.
- [x] Update documentation, provisioning, and existing callers for the revised design.
- [x] Complete applicable checks and record evidence for the revised implementation.

## Outcome

Implemented integration of additional independently versioned ADR sets, including private company standards, alongside
shared Workbench decisions and project-local decisions. Preserve source identity, explicit scope, provenance, human
review, and explicit conflict resolution without copying shared decisions into local ownership.

## Current state

The human requested planning on 2026-10-09 and agreed to shared user/system collection installations on 2026-10-10.
Draft workbench:ADR-L specializes the existing inheritance and adoption foundations. It was originally numbered ADR-18;
workbench:TSK-H later grouped these unaccepted drafts before initial review. The initial implementation preserved
existing records. Existing integration combines the pinned `.workbench` distribution's root decisions with local project
scopes. Decision discovery previously assumed that single shared source. ADR sets use integration. Other shared content
types may be supported later through their defining decisions; no additional inherited record types are requested now.
The human requested moving the former Workbench scheduling draft into benchd:ADR-0 as the first shipped collection. The
initial migration and verification finished before the revised installation model; shared Workbench references now use
applicable resource policies without requiring the optional benchd collection. Governing documents remain drafts pending
exact-text human review.

## Design

Follow workbench:ADR-L. Local installations at system, user, and ignored checkout scope apply automatically, with the
installation registry selecting an immutable revision. Shared project installations include verified contents and pins
in the repository, so every contributor and CI receives the same policies. Neither case changes ADR integration into
replacement. Local installation cannot silently change shared pins or satisfy missing shared dependencies.

Tracked context directs agents to read current local context through Workbench. Shared maps and instructions contain
only portable project policy. Shared records cannot depend on optional local records. Local CI freezes verified local
policies for its disposable workspaces; ordinary packages and provider exports exclude them. Identical local/shared
selections covering the same scopes deduplicate; conflicting selections fail explicitly. The benchd export remains
available without being a required Workbench dependency. Its actual application installer integration remains future
benchd work.

## Verification plan

Exercise user, system, and explicit local installations; side-by-side provider upgrades; identical and conflicting
duplicates; automatic local applicability and tracked project installation; missing selected revisions; and modified
installed contents. Verify that the same tracked pin resolves consistently across different machine paths and that
provisioning can reproduce the selection in CI and development containers. Use fixtures to demonstrate consumer exports
without importing provider implementation decisions.

Prepare a consumer fixture with Workbench, synthetic company standards, and local project decisions. Demonstrate
combined context, stable references, scoped overrides, sibling isolation, source updates with reviewable differences,
offline operation, and unchanged project-owned records. Cover collisions, conflicts, missing sources, invalid pins,
unsupported schemas, dependency cycles, path escape and symlink handling, and source removal while references remain.
Verify that non-ADR records and source repository settings never become inherited. Exercise adoption, update, and
standalone packaging with private-source handling represented by synthetic fixtures. Draft the relevant foundational ADR
changes before implementation, preserving ADR ordering and leaving exact-text acceptance pending human review.

## Findings

The following findings and verification describe the initial implementation, before the revised local/shared design.
They do not verify the current changes.

Collection installation consumes an already acquired directory and an independently recorded manifest SHA-256; it does
not add another downloader or package manager. Acquisition remains with authorized repository/package tooling and the
existing authentication policy. The closed manifest inventories only exported ADRs and maps. Verification uses bounded
reads, rejects symlinked records and unsafe paths, checks every file hash and derived map, and publishes verified bytes
through private staging. Immutable revisions coexist and conflicting installed copies fail rather than changing the
selected policy.

The pinned Workbench distribution declares benchd revision 1 in `collections/index.toml`. The scheduling draft moved out
of Workbench's decisions into the benchd namespace without changing its policy; Workbench's dependent ADRs and agent
context reference the exported identity. The original Workbench ID remains unused. Actual benchd application installer
integration belongs to its future Workbench adoption; this change ships a complete collection through Workbench and
verifies the generic collection installer.

External sources use ignored stable project links. Staged commit gates materialize those links without tracking them,
updates preserve machine-local source configuration, and local CI freezes verified files into disposable workspaces
accessible to containers. Standalone packaging carries verified public revisions and regenerates context from the
packaged sources. Private policy comparisons and bundles require an explicit private audience; ordinary Workbench
distribution packaging rejects private sources before writing output, and update reports omit private context text.

Review corrected the isolated coverage checkout and evaluation fixtures to include shipped collections while excluding
machine-local links. Linked ADR filenames now resolve through their actual owning namespace, including sibling
namespaces in one collection, and obey reference ordering and scope rules. Exports reject omitted text references and
file links before publishing a destination. All private-source evidence uses synthetic policies.

## Validation of the initial implementation

On 2026-10-10, all 26 collection regressions passed, followed by the full root CI gate: 304 tests in 60 files,
formatting, lint, types, bundle parity, structural validation, shell and workflow checks, executable README examples,
dependency advisories, and credential scanning. Coverage passed the existing floors: 89.37% lines, 84.38% statements,
90.48% functions, and 77.09% branches.

The complete native commit-stage gate passed for Workbench and all seven example roots on Linux x64, including C/C++ LTO
and sanitizer checks and Go race tests. Portable C/C++ builds retain their expected AVX2 skips; native and optimized
AVX2 tests passed. The migration preserves the previous scheduling policy exactly apart from its ADR identifier. Source
hashes, selected pins, commands, limits, and log locations are retained in
`workbench/evidence/collections-20261010.json`.

No full Linux container matrix or hosted matrix was rerun for this task. Existing local CI adapters and frozen external
policy provisioning have behavioral regressions; hosted OS/architecture, managed-environment, cache, and publication
verification remain workbench:TSK-7 after human implementation review. No commit, push, publication, or review-receipt
change was performed.

## Revised applicability implementation

The follow-up separates automatic local registries from portable shared project pins. Installation supports user,
system, ignored checkout-local, and tracked project scopes. Shared installation copies verified contents, records its
pin, and preserves existing applicable scopes on upgrade. Local installation atomically selects its revision, retaining
older immutable contents without requiring activation. Identical local/shared selections deduplicate; differing
selections fail explicitly. Shared decisions cannot depend on optional local records.

Tracked context and maps contain shared policies and a stable instruction to read local context. The local context
command reads verified policies dynamically. Local CI freezes local selections with their verified files; packages,
provider exports, and shared update reports exclude them. Existing collection and update fixtures were migrated to these
semantics. The available benchd export is no longer a Workbench dependency, and its collection is installed at ignored
checkout-local scope here. Its application installer integration remains future benchd work.

Verification corrected the collection CLI fixture to invoke the bundle with an explicit project root, matching the other
CLI fixtures and preserving the owning-checkout launcher contract. Shared-upgrade assertions compare semantic pin fields
independently of TOML object prototypes, and private local-context assertions tolerate canonical wrapping. Routine Linux
tests isolate system collection lookup from host installations. Regressions additionally verify clone portability
without host sources, automatic local upgrades, preserved shared scopes, dependency and reference boundaries,
local/shared duplicate resolution, private export exclusion, and frozen local context after host removal.

On 2026-10-10, all 31 collection tests passed. All four update tests passed in the preceding focused run and again in
both complete gates. The full root CI gate passed 309 tests in 60 files, formatting, lint, types, bundle parity,
structural validation, shell and workflow checks, executable README examples, dependency advisories, and credential
scanning. Coverage passed unchanged floors: 89.13% lines, 84.13% statements, 90.53% functions, and 76.73% branches. HEAD
contains no committed coverage summary, so comparison with a committed baseline remains unavailable.

The complete native commit-stage gate then passed Workbench and all seven example roots on Linux x64, including C/C++
LTO and sanitizer checks and Go race tests. Portable C/C++ builds retain their expected AVX2 skips; native and optimized
AVX2 tests passed. Commands, selected pins, source hashes, coverage totals, and log locations are recorded in
[revised verification evidence](../evidence/collection-applicability-20261010.json). The earlier evidence above remains
historical and does not substitute for these results.

No full Linux container matrix or hosted matrix was rerun. Cross-platform, managed-environment, cache, and publication
verification remain workbench:TSK-7 after human implementation review. No commit, push, publication, ADR acceptance, or
review-receipt change occurred.
