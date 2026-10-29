---
summary: Personal skill selection, pinned definitions, scoped harness discovery, invocation controls, and evaluations.
---

# ADR-6: Skills and harness integration

Keep Workbench-supplied skill definitions in each project's pinned Workbench executable distribution. Users enable or
disable individual skills in user configuration; projects do not override that selection. Expose applicable selected
definitions through ignored project-local harness discovery links, preserving independently authored skills and
resolving name collisions explicitly. Skill discovery requires the project's pinned distribution locally. Skills own
selected workflows and non-obvious mechanics; ADRs own policy. Disabling a skill does not waive an applicable policy
requirement.

Intersect personal selection with project applicability: language skills require matching registered roots; environment
update skills require checks using that environment locally or in CI. Definition files alone do not activate them.
Skills verify their target scope. New skills start disabled. Synchronization refreshes local discovery; executable
updates report added, removed, and changed skills while preserving personal choices. Shared validation does not require
personal discovery links. Discovery makes a skill available, not scheduled. Descriptions define selection criteria.

Verify actual instruction and skill discovery in isolated, explicitly selected tests without retained conversation
history. Evaluate substantial workflow changes through realistic disposable projects, checking behavior, scope, and
advice quality. Keep model-dependent evaluations separate from deterministic gates and record the model, skill revision,
outcomes, and limitations.

Rationale: Pinned definitions avoid divergent skill copies; personal selection, project applicability, and precise
triggers bound context and work. Behavioral evaluation verifies usable integration beyond files merely existing at
plausible paths.
