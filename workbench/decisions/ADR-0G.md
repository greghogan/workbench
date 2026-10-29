---
summary: Atomic visibility, explicit conflict resolution, durability guarantees, and interruption recovery.
---

# ADR-G: Durable state and recovery

Caches are disposable; deleting them preserves authoritative data. Make each declared unit of persistence visible
atomically. Reject conflicting writes by default; overwriting a conflict requires an explicit operation.

Report persistence success only after its declared durability guarantee is met. Provisional application state remains
distinguishable from confirmed persistence.

Retain the information needed to recover interrupted durable operations without duplicating completed effects. Recovery
may resume, roll back, or safely discard incomplete work. Cleanup preserves authoritative data and information still
needed for recovery.

Rationale: Explicit persistence and recovery guarantees protect user work across conflicting writes, interruptions, and
partial failure without prescribing a storage mechanism.
