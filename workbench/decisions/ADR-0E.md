---
summary: Failure causes, safe bounded retries, explicit outcomes, purposeful logs and metrics, and diagnostic limits.
---

# ADR-E: Errors, diagnostics, and observability

Failures identify the operation and preserve the underlying cause. Report cleanup failures without obscuring an earlier
failure. Automatic retries have explicit limits and report attempts and exhaustion. An operation with an uncertain
outcome may be retried automatically only when repetition cannot duplicate its effects.

Unavailable data, unsupported operations, and failures remain distinct from valid empty or zero results. Report desired
state, observed state, and operation outcome separately; cancellation alone does not establish whether changes were
applied or completed.

Select logs and operational metrics that support diagnosis and evaluation. Logs identify relevant operations and
outcomes; metrics have defined meanings, units, and aggregation. Externally consumed machine-readable output follows a
stable schema. Keep collection costs bounded, and diagnostic output and telemetry buffering within explicit limits. Make
truncation, dropped events, and other omissions that affect interpretation visible. Disclose instrumentation that
materially affects reported measurements.

Rationale: Callers need to know what happened, what remains uncertain, and whether diagnostic or measurement limits
affect the evidence.
