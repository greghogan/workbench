---
summary: Whole-changeset review, cause and recurrence, semantic boundaries, and coherent commits.
agent_instruction:
  Before reporting completion or committing, review the complete pending changeset; repeat after corrections until a
  pass requires no further in-scope changes.
---

# ADR-C: Review and coherent changes

Agents review the complete pending changeset for correctness, scope, failure handling, and agreement among behavior,
tests, documentation, decisions, and generated artifacts. Fix material findings and worthwhile safe simplifications,
rerun affected checks, and repeat review until a complete pass requires no further in-scope changes before reporting
completion or committing. Report verification, unresolved findings requiring human decisions, and other limitations.

Investigate causes of defects and unsuitable structures encountered during authorized work, and prevent recurrence in
the responsible definitions or checks. Record independent opportunities as tasks or feedback without deferring defects
that prevent the current change from meeting its intent. Requested refactor reviews explain the concrete value of
recommendations. Policy changes retain ADR-1 review.

Modules follow cohesive ownership, state, and invariants rather than file-length quotas. Length and churn prompt
inspection, not prescribed boundaries. Refactoring may split, join, move, or remove code; avoid wrappers without a
distinct contract. Create shared packages for stable boundaries used by multiple consumers, keeping consumer-specific
models private.

Commits keep coherent changes with their tests, documentation, decisions, and derived files. Commit conventions are
configurable; keep exact formatting defaults in configuration and the contributing guide. Recent-commit reviews and
full-codebase audits are separately requested activities. Human approval follows each record's policy, not ordinary code
or generated-file changes by default.

Rationale: Semantic boundaries make invariants understandable; coherent changes and review keep implementation and
evidence together while improving the practices that produced them.
