---
name: review-project
description:
  Review an existing project or selected area with the developer's chosen focus when explicitly invoked. Use for a
  comprehensive assessment or design reconsideration across recent work, not routine completion review.
disable-model-invocation: true
---

# Project review

Establish scope, focus, and any effort boundary. An unqualified invocation covers the whole project. A capability,
subsystem, task, directory, or explicit recent-work request narrows the scope; recent work can include committed
changes. Focus directs attention without hiding relevant cross-cutting problems. Inspect the repository before asking
about an ambiguous boundary, then offer concrete scope choices when needed.

Read applicable authority and inspect the current implementation afresh. Previous reviews and task records provide
context; test their conclusions against the system. Build an ownership and dependency model, then follow consequential
boundaries and failure paths. Consider architecture, behavior, recovery, tests, documentation, and checks as relevant.
Implementation experience can justify simpler state, better boundaries, consolidation, or removing unnecessary work.

Use a Workbench review task as the log, reusing an existing one when appropriate. Keep a human-readable overview above
evidence, reviewed and unexamined boundaries, unresolved concerns, and the next entry point. Do not create a parallel
audit ledger. Honor an explicit advice-only request to leave files unchanged by returning the review directly.

Address every substantiated finding within scope, without a numerical cap or target count. Make small verified repairs
and behavior-preserving simplifications directly unless the request is advice-only. Preserve user work and required
record review; verify and review the resulting changes. Summarize numerous small fixes by theme rather than enumerating
refactors. Explain the evidence, benefit, and trade-offs for unresolved design choices or larger follow-ups, grouping
related proposals into coherent subtasks. Keep unverified concerns separate, and record coverage limits rather than
claiming an exhaustive guarantee. Avoid repeating resolved findings without new evidence.

Keep proposed follow-ups in the log until the developer reviews them; do not populate the accepted queue prematurely.
Continue inspection beyond the first useful findings.

Obtain developer review before proposals become approved follow-up work. Reconcile accepted, rejected, revised, and
deferred proposals in the log, creating subtasks for selected groups with links to their review provenance. Proposal
acceptance does not itself authorize implementing every follow-up. When authorized, commit the log and verified repairs
locally while developer review remains pending, and fold subsequent corrections into coherent unpublished commits.

Report fixed findings, proposed work, evidence, remaining questions, and the log location. Honor existing authorization
without repeatedly asking about settled choices. Do not stage or commit unless requested, or push task work before
required developer acceptance and push authorization. Keep meaningful task updates with related changes; authorized
fixups may be folded into the task's own unpublished commits while preserving unrelated and published history.
