---
summary: Atomic publication, conflicts, recovery receipts.
---

# ADR-10: Durable state and recovery

Treat stored user data as authoritative and caches as rebuildable projections. Publish complete replacements and reject
concurrent-write conflicts by default; overwriting a conflict is an explicit operation. Install application state after
persistence succeeds, retaining a distinct outcome for committed changes with uncertain crash durability.

Multi-step durable operations use recoverable intent or completion receipts. Retrying completed work reuses the recorded
outcome. Cleanup preserves durable work and evidence; disposable projections may be rebuilt.

Rationale: Explicit commit and recovery contracts preserve user work across concurrent access and partial failure.
