---
status: Done
parent: null
depends_on: []
---

# TSK-I: Support pinned shared Workbench installations alongside submodules

## Review summary

Add versioned user/system Workbench installations alongside project submodules. Each project retains an exact portable
pin while sharing immutable installed bytes. The human prefers this reduction in duplicate copies over aggressively
removing reference material. Design includes Guix-like profiles, retained generations, garbage-collection roots, and
similar owner separation. Implementation and local verification are complete. Hosted platform verification follows in
workbench:TSK-7; draft policy remains pending human review.

## Context

Requested on 2026-10-11 after workbench:TSK-F's packaging review. Retain full reference material once per installed
revision initially; a smaller runtime must be able to omit it without breaking execution. Avoid adding package variants
until a concrete workflow needs them. Project submodules remain fully supported. This is independent of optional policy
collections: a Workbench version is the project's executable and definition dependency.

## Progress

- [x] Draft installation, pin, retention-root, and access-control policy in workbench:ADR-2 and workbench:ADR-J.
- [x] Record the integration boundaries and profile design for review.
- [x] Separate project identity, pinned distribution identity, and physical installation lookup.
- [x] Implement verified immutable installation, exact-version dispatch, and project registration for all three scopes.
- [x] Apply one consistent pin to records, definitions, skills, launchers, hooks, and CI workspaces.
- [x] Extend isolated updates and recovery to shared installations while preserving submodule updates.
- [x] Implement owner-controlled profiles, generations, active-use roots, removal, and conservative pruning.
- [x] Verify relocation, multiple projects/versions/users, access controls, interruption, and pruning races.
- [x] Verify Linux x64 locally and hand off remaining native platforms to workbench:TSK-7.

## Plan

See [shared installation design](../guides/installations.md). Keep user/system paths out of tracked pins. Preserve
portable agent-context links and skill discovery, and handle Windows filesystem/ACL semantics explicitly. Local and
hosted CI must receive the project's exact distribution even when no `.workbench` Git checkout exists. Installing or
pruning must coordinate with updates and active processes; historical branches can require an explicit reinstall after
their version is no longer retained.

## Findings

Shared versions are sealed inventories with exact content pins. Project registrations and portable `.workbench`
references select the same verified dependency for commands, policies, skills, hooks, updates, and CI snapshots. Mutable
Dev Container CLI dependencies live in the cache. Container wrappers use the portable dependency reference, including
when the workspace has a different depth from its host path.

Moved or copied registrations require explicit repair and receive separate profiles; the old profile remains retained
until explicitly removed. Maintenance fences concurrent root publication, and uncertain roots or writer claims stop
pruning. System maintenance copies and validates bytes without executing project code.

## Outcome

Multiple projects may use different pinned Workbench versions from one user or system installation. Updates change only
the selected project; old versions remain while any profile, retained generation, active use, or recovery operation
references them. Users may mutate their own roots but cannot change shared immutable content or other users' roots.
Administrator pruning considers all registered owners without crawling or executing arbitrary project code. Submodule
adoption and updates retain their existing behavior.

## Validation

The nine focused installation/update checks pass, covering seals and path bounds, relocated checkouts, independent
snapshots, missing versions, generations, active-use retention, conservative prune recovery, failed update preparation,
unchanged indexes, and staged pins despite unstaged drift. Existing submodule update checks also pass.

A real Linux x64 two-user system-store test passes: users cannot change immutable system contents or another account's
roots; administrator pruning preserves both owners' retained versions and removes them only after release. A packaged
consumer passes its JavaScript Dev Container gate with a read-only shared distribution at a different workspace depth.
The final full root gate passes all 366 tests and 13 configured checks, including coverage floors. Native Windows ACLs
and macOS behavior require hosted verification under workbench:TSK-7; no claim of hosted success is made here.

See [shared installation evidence](../evidence/shared-installations-20261011.json).
