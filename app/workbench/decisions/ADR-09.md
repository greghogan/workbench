---
summary: Independent diagnostic destinations, execution histories, protected retention, and visible logging failures.
---

# ADR-9: Diagnostic logging and retention

Workbench separates console diagnostics from retained diagnostic history. CLI and server logging preferences are
independently configurable, with invocation overrides; reducing console verbosity does not discard events selected for
retention. Structured diagnostics preserve operation context and causes under workbench:ADR-E.

Retain CLI and server diagnostics by default. Save normal CLI operations quietly and identify their retained diagnostics
when they fail. Separate individual CLI execution histories from long-running service histories and check output. Keep
retained histories inspectable independently of current logging preferences.

Retention favors recent diagnostic context over older history. Disabling age-off preserves configured size limits for
CLI, server, and check logs. Age and stored-size policies apply to complete eligible units; active use, explicit
retention, and uncertain ownership protect evidence. Rotation preserves event boundaries and ordered service history.

Report logging, compression, and retention failures and make dropped or truncated diagnostics visible. Preserve
remaining evidence and keep otherwise usable application operations available. Diagnostic storage and cleanup follow
workbench:ADR-I and ADR-2.

Rationale: Independent destinations allow quiet interaction without losing diagnostic context. Protected retention keeps
recent operations explainable while reclaiming older history safely.
