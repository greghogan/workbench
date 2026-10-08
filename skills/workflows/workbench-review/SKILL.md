---
name: workbench-review
description:
  Review and finish a Workbench changeset after implementation or when asked to review pending changes; fix worthwhile
  in-scope issues before reporting completion. Not a full-project audit.
---

# Changeset review

Use the applicable review and test-quality decisions. Identify the authorized change from requirements, current edits,
and immediate callers; include untracked implementation files. Preserve unrelated work.

Review behavior, failure paths, tests, documentation, and generated artifacts together. Also look for worthwhile
simplifications in the implementation just produced: unnecessary abstractions, duplicated paths, and dead transitions.
Passing checks does not complete this review.

Fix clear, in-scope defects and simplifications immediately. Recheck affected behavior and the final diff. Continue
while material findings remain; finish when the change meets its intent and remaining opportunities require a distinct
scope or design choice. Do not create follow-up tasks merely to defer cleanup that belongs in this change.

Present unresolved choices with evidence, value, and a recommendation. Report what changed and the verification
performed. Do not stage or commit unless requested. A later refactor review may reveal a missed issue; address the
evidence without inventing findings or expanding the current review into an unsolicited repository audit.
