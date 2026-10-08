---
summary: Agent cleanup, follow-up scope, commit conventions.
---

# ADR-E: Review and coherent commits

Agents review the whole pending changeset for correctness, scope, failure handling, and consistency between behavior,
tests, documentation, decisions, and generated artifacts. Apply the test-quality standard in ADR-C and preserve the
engineering constraints in ADR-B.

Fix material findings and safe, worthwhile simplifications before completion, even when checks already pass; rerun
affected checks and review the result. Record independent work as tasks or feedback, without deferring defects that
prevent this change from meeting its intent. A requested refactor review may find missed improvements; distinguish them
from independent design opportunities and explain their value. Report verification and unresolved limitations.

A commit keeps a coherent change with its tests, documentation, decisions, and derived files.

Commit conventions are configurable; the default is Conventional Commits with 50-character subjects and 72-character
body lines.

Recent-commit review and full-codebase audit are separately requested activities. Human approval follows each applicable
record policy; ordinary code and generated files do not require it by default.

Rationale: Coherent commits preserve a reviewable explanation of the change and keep its behavior and evidence together.
