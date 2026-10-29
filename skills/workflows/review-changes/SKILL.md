---
name: review-changes
description:
  Review and finish authorized implementation before commit or task completion, including worthwhile in-scope design
  improvements. Use for delivery review, not an exploratory project review.
---

# Changeset review

Use the applicable review and test-quality decisions. Before commit, review the complete pending changeset, including
untracked implementation files. Before task completion, review the accumulated implementation across relevant commits
and pending changes against its intended outcome. Establish scope from requirements, task records, session decisions,
and immediate callers; do not assume the last diff contains the entire task. Preserve unrelated work.

Review behavior, failure paths, tests, documentation, and generated artifacts together. Also look for worthwhile
simplifications and design improvements revealed by implementation: unnecessary abstractions, duplicated paths, awkward
boundaries, and dead transitions. Inspect the resulting system and interactions between changes, rather than only
reviewing commits individually. Passing checks does not complete this review.

When ADRs change, review them against the decision-authoring contract: intended outcomes, clear applicability, and
rationale; implementation mechanisms only when deliberately chosen as durable constraints.

Fix clear, in-scope defects and simplifications immediately. Recheck affected behavior and the final diff. Continue
while material findings remain; finish when the change meets its intent and remaining opportunities require a distinct
scope or design choice. Do not create follow-up tasks merely to defer cleanup that belongs in this change.

Present unresolved choices with evidence, value, and a recommendation. Report what changed, verification, and any
remaining developer acceptance; summarize numerous small fixes by theme without a finding quota or an approval round for
each refactor. Agent verification does not establish human acceptance. Do not stage or commit unless requested, or push
completed task work before required developer acceptance and push authorization. Include meaningful task updates with
the changes they describe; when authorized, fold follow-up fixes into the task's own unpublished commits, preserving
unrelated work and published history instead of creating incidental state-only commits.

When configured, record content-bound agent review evidence with `workbench review changes` before commit and
`workbench review task --base REVISION` for accumulated work before publication. Inspect the printed snapshot, then
record its digest with a concise assessment and verification. Current files are the default; use `--staged` explicitly
for a partial commit. Review never stages files. The gate requires the eventual staged contents to match. Associate
applicable tasks and retain human approval and acceptance. Never record review before performing it or use an agent
receipt to substitute for a human decision.

A later requested project review can still reveal worthwhile opportunities. Address evidence without inventing findings
or expanding completion review into an unsolicited project audit.
