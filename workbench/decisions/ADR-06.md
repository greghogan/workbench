---
summary: Discovery, triggers, harness tests, evaluations.
---

# ADR-6: Skills and harness integration

Apply ADR-1's integration mode. Shared skill sources remain in the pinned distribution and are discovered alongside
project-owned skills. Generated discovery links reference shared sources rather than creating project-owned copies.
Preserve separately owned project skills across synchronization and updates; resolve name collisions explicitly.

Skills encode our selected workflows and their non-obvious mechanics; decisions own policy. Keep one canonical Agent
Skills source for each workflow. Expose shared workflows and the union needed by configured language roots and check
environments through each supported harness's discovery mechanism. Environment update skills activate only when a check
uses that environment locally or in configured CI coverage; retaining its definition files alone does not activate a
skill. Generate shared discovery from committed configuration; local execution preferences do not change it.

Use repository-local discovery and one root `AGENTS.md`. Each skill verifies its target scope. Synchronization maintains
Workbench-owned links without replacing user-owned skills. Document supported harnesses and verify actual instruction
and skill discovery in isolated, explicitly selected tests that do not retain local conversation history.

Evaluate substantial workflow changes with realistic requests in disposable projects. Check resulting behavior and scope
preservation, and review advice for concrete value. Keep model-dependent evaluations separate from deterministic
discovery checks and routine gates; record the tested model, skill revision, outcomes, and limitations.

Discovery makes a skill available; it does not schedule execution. Descriptions identify when an agent should select a
skill. Changeset review accompanies implementation; refactor advice and defect investigations follow matching requests.
Full-project audits require explicit invocation. Keep equivalent invocation controls consistent across harnesses.

Rationale: Shared sources prevent drift; scoped discovery and precise triggers control context and work. Behavioral
checks distinguish supported integration from files that merely exist at plausible paths.
