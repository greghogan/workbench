---
summary: Whole-changeset review, cause and recurrence, semantic boundaries, and coherent commits.
agent_instruction:
  Review the pending changeset before commit and the accumulated work before task completion; fix findings and repeat
  until no further in-scope changes are needed and record applicable review evidence. Keep implementation unpublished
  until human acceptance and publication authorization.
---

# ADR-C: Review and coherent changes

Before commit, review the complete pending changeset; before task completion, review the accumulated implementation
across its commits and pending changes against the intended outcome. Assess correctness, scope, failure handling,
interactions, and agreement among behavior, tests, documentation, decisions, and generated artifacts. Fix material
findings and worthwhile design improvements, rerun affected checks, and repeat until a complete pass requires no further
in-scope changes. Report verification, unresolved decisions, and limitations. Retain content-bound evidence of agent
change and accumulated task review. Required review evidence must cover committed and outgoing work; human record
review, plan approval, and outcome acceptance retain their independent authority.

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
full-codebase audits are separately requested activities. Planning and approval records may be published for
coordination. Local commits and revisions may precede human acceptance. Publishing implementation requires human
acceptance and an explicit request to publish; approval to implement a batch is insufficient. Consolidate follow-up
corrections with the unpublished work they amend, preserving unrelated work and published history. Avoid commits solely
for local execution progress. Human approval follows each record's policy, not ordinary code or generated-file changes
by default.

Rationale: Semantic boundaries make invariants understandable; coherent changes and review keep implementation and
evidence together while improving the practices that produced them.
