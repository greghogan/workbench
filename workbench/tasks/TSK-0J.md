---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-J: Preflight collection selections before changing active pins

## Review summary

Check proposed collection selections against the combined applicable policy before changing a local registry or shared
project pin. Preserve the previous selection on rejection and support related dependency upgrades in one selection. The
human approved this review finding on 2026-10-11. Implementation and local Linux x64 verification are complete; draft
policy remains subject to human review.

## Context

Workbench:TSK-F found that individually verified collections could be selected before dependency, namespace, scope, or
ADR-graph conflicts were discovered. Reuse the normal resolver with proposed pins, including local context when invoked
within a project. Outside projects, check installed collections and the distribution's policies without creating a
project. No claim extends to undiscovered projects affected by machine/user policy.

## Progress

- [x] Resolve proposed pins without changing the active registry or project configuration.
- [x] Preflight CLI installation and related dependency batches before publishing selections.
- [x] Verify rejection preserves old pins, scopes, records, and context; validate successful updates and lock handling.
- [x] Update policy, help, guides, bundles, and complete the root quality gate.

## Plan

Prepare and authenticate immutable contents, then validate the combined proposed selection under the owning selection
lock. A rejection may retain unused verified contents; it must not select them. A batch targets one installation scope
and publishes one registry/configuration change. Keep ordinary context validation because other project or installation
changes can still invalidate policy later.

## Findings

Rejecting a dependency update independently can also prevent its dependent from updating to the same new pin. Support
selecting those exports together, with one recorded digest per source, rather than requiring a temporarily invalid
selection. Conflicts between independently owned installation locations still require explicit resolution.

## Outcome

Collection installation reports a useful preflight failure and retains the previous active policy. Successful single and
batch installations keep automatic local applicability, shared scope preservation, immutable revisions, and offline
context resolution.

## Validation

On 2026-10-11 the native root CI-stage gate passed all 13 configured checks, including 354 tests across 64 files,
coverage floors, formatting, lint, types, bundle parity, documentation, advisories, and credential checks. The
collection suite includes 11 new cases for rejected updates at all four installation scopes, batches, namespace
conflicts, outside-project use, and selection locks. Existing tests verify scope preservation and offline consumer
behavior.

After the full-suite snapshot was taken, the system-installation fixture was changed to use an explicitly registered
temporary directory on every platform. Its formatting, lint, and all 44 collection tests passed again under pinned Node
26.11.1. This isolates the fixture; macOS and Windows execution remain part of workbench:TSK-7. See
[verification evidence](../evidence/collection-preflight-20261011.json). No commit, push, or ADR acceptance occurred.
