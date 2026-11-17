---
name: review-changes
description:
  Review and finish authorized implementation before commit or task completion, including worthwhile in-scope design
  improvements. Use for delivery review, not an exploratory project review.
---

# Implementation review

Use the applicable review and test-quality decisions. Before commit, review the complete pending changeset, including
untracked implementation files and their immediate interactions. Before task completion, assess the integrated outcome
across relevant commits and pending work against the approved intent. Establish scope from requirements, task records,
session decisions, and callers; the last diff is not the task boundary. Preserve unrelated work.

Review behavior, failure paths, tests, documentation, and generated artifacts together. Review the proposed commit
message for an accurate summary and useful rationale and verification; omit boilerplate. Run
`workbench commit check MESSAGE_FILE` before expensive gates when preparing a message separately. Also look for
worthwhile simplifications and design improvements revealed by implementation: unnecessary abstractions, duplicated
paths, awkward boundaries, and dead transitions. Use implementation experience to reconsider the design as a whole,
including whether internal mechanisms have become unnecessary user-facing work. Passing checks does not complete this
review.

For user-facing work, exercise the affected running interface as a complete workflow, using the reviewed version.
Use the plan's wireframes and acceptance scenarios to inspect the delivered interactions, states, and transitions.
Test results and generated screenshots alone do not establish that review. Include affected records, help, and other
delivered text. Resolve ordinary design refinements within the approved direction and refer consequential product
choices to the developer.

For substantial tasks, use a fresh-context reviewer when available and authorized. Supply the intended outcome,
applicable authority, source, and evidence without coaching toward the author's verdict. Otherwise report the
same-context limitation. State what was exercised and observed and what remains unexamined; preserve that distinction
when recording review evidence.

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

For authorized provisional local commits, use `workbench commit --provisional` with the normal message; Workbench adds
the publication-blocking marker. Arrange retained commits before human review, then use `workbench commit reviews` and
`workbench review --commit REVISION` for each pending unit. Use `commit finalize` after required decisions and agent
evidence are complete; preserve any changed-snapshot verification requirements. Do not remove a marker to bypass review.

A later requested project review can still reveal worthwhile opportunities. Address evidence without inventing findings
or expanding completion review into an unsolicited project audit.
