# ADR-4: Plans and task continuity

Summary: Plans become durable tasks progressively, preserving context without fixing every detail in advance.

A task records an outcome, state, current plan, material findings, and completion evidence. Plans gain detail as work
approaches implementation.

Move independently actionable or verifiable work into a child task and replace the parent detail with a reference.
Each task has at most one parent; dependencies express ordering. Workbench rejects missing references and cycles.

A parent finishes only when its outcome is demonstrated and children are done or canceled. Link related records
instead of copying them.
