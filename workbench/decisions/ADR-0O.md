---
summary: Causes, retries, outcomes, telemetry.
---

# ADR-O: Errors, diagnostics, and observability

Failures retain their cause, operation, and useful identifiers. Report cleanup failures; bound and expose retries.

Keep unavailable, unsupported, failed, and valid zero observations distinct when they affect interpretation. Desired
state, observed state, and operation outcome are separate; cancellation does not imply rollback or successful
completion.

Machine-readable output has a stable schema when consumed externally. Bound diagnostics and telemetry, omit secrets, and
disclose instrumentation that materially affects measured behavior.

Rationale: Actionable, bounded diagnostics support repair and investigation without exposing credentials or overwhelming
users.
