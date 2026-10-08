---
summary: benchd scheduling and approved bypass.
agent_instruction: With benchd installed, use `benchctl hold` for builds, tests, and CPU-heavy work; ask before bypass.
---

# ADR-U: Execution resources

Use the installed scheduler for substantial execution work. An unavailable or failing installed scheduler is not
permission to bypass it. When no scheduler is installed, host execution is allowed. Experimental records retain the
execution provenance required by ADR-9.

Rationale: Coordinating expensive work protects other workloads and measurement conditions without imposing a scheduler
installation on every consuming project.
