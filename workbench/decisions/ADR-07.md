---
summary: Task hierarchy, completion, history, commit references.
---

# ADR-7: Plans and task continuity

A task records an outcome, state, current plan, material findings, and completion evidence. Plans gain detail as work
approaches implementation.

Move independently actionable or verifiable work into a child task and replace the parent detail with a reference. Each
task has at most one parent; dependencies express ordering. Workbench rejects missing references and cycles.

A parent finishes only when its outcome is demonstrated and children are done or canceled. Link related records instead
of copying them. Retain completed and canceled task records; exclude them from the active task map and default record
queries, while allowing explicit history searches.

Commit messages reference scoped task IDs when relevant. Tasks may cite existing commits as evidence, but need not
contain the hash of their own completion commit.

Rationale: Progressive planning preserves continuity without spending attention on detail that may change before
execution.
