---
summary: benchd scheduling and approved bypass.
agent_instruction: With benchd installed, use `benchctl hold` for builds, tests, and CPU-heavy work; ask before bypass.
---

# ADR-0: Execution resources

Use the installed scheduler for substantial execution work. An unavailable or failing installed scheduler is not
permission to bypass it. When no scheduler is installed, host execution is allowed. Substantial experimental execution
uses the same scheduling boundary as builds and tests.

CPU worker budgets are separate from scheduler admission. Configure a common allocation for parallel-capable build and
test tools; bound concurrent local CI jobs by available CPUs and their allocations. Each job owns its workspace and
build outputs, while verified tool installations and download caches may be shared with appropriate locking. Ordinary
benchd holds coordinate workloads without assigning general per-job CPU or memory quotas.

Rationale: Coordinating expensive work protects other workloads and measurement conditions without imposing a scheduler
installation on every consuming project.
