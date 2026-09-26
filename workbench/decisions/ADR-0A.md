# ADR-A: Errors, diagnostics, and observability

Summary: Failures retain actionable context while diagnostics remain structured, bounded, and safe to disclose.

Failures retain their cause, operation, and useful identifiers. Report cleanup failures; bound and expose retries.

Machine-readable output has a stable schema when consumed externally. Bound diagnostics and telemetry, omit secrets,
and disclose instrumentation that materially affects measured behavior.
