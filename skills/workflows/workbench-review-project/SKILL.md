---
name: workbench-review-project
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

The explicit request authorizes the review and verified small repairs within scope. Reuse an existing task when it
owns the review. For a separately tracked review, create the task with the requested scope, read its digest with
`workbench task show REF --json`, then use `workbench task authorize-review REF --expected DIGEST` to append it to the
queue. Use `workbench queue --ready` to determine when the review can start. If eligible work is ahead, report the
review's queue position and await its turn or explicit independent scheduling. For advice only, return the review
directly.

Address every substantiated finding within scope, without a numerical cap or target count. Make verified small repairs
and behavior-preserving simplifications within scope. Preserve user work and required record review.
Verify and review the resulting changes. Summarize numerous small fixes by theme rather than enumerating
refactors. Explain the evidence, benefit, and trade-offs for unresolved design choices or larger follow-ups, grouping
related proposals into coherent groups. Keep unverified concerns separate, and record coverage limits rather than
claiming an exhaustive guarantee. Avoid repeating resolved findings without new evidence.

Continue inspection beyond the first useful findings. Keep findings, evidence, and fixes together in the review task's
implementation account and its first local commit, subject to the commit gates. Keep findings needing a developer
decision as recommendations until approved. If the developer expands the current delivery, seek revised approval on
the same task and preserve its progress. Selected independent follow-ups go through ordinary planning.

Report fixed findings, proposed work, evidence, remaining questions, and the log location. Honor existing authorization
without repeatedly asking about settled choices. Do not stage or commit unless requested, or push task work before
required developer acceptance and push authorization. Keep meaningful task updates with related changes; authorized
fixups may be folded into the task's own unpublished commits while preserving unrelated and published history.
