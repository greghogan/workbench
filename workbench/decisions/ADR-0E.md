# ADR-E: Review and coherent commits

Summary: Coherent changes are reviewed and mechanically validated before commits preserve their result and rationale.

Review the whole pending changeset, tests, and generated artifacts. Record material findings as tasks or feedback.

A commit keeps a coherent change with its tests, documentation, decisions, and derived files.

Commit conventions are configurable; the default is Conventional Commits with 50-character subjects and 72-character
body lines.

Recent-commit review and full-codebase audit are separately requested activities. ADR acceptance follows ADR-0.
