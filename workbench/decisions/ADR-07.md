---
summary: Adaptive plans, human approval and acceptance, task relationships, and completion evidence.
agent_instruction:
  Obtain human approval of a concrete plan before implementing a major feature or materially expanding its approved
  scope.
---

# ADR-7: Tasks and feedback

Project-owned `TSK` records retain a searchable account of intended outcomes, evolving plans, material findings, and
completion evidence across coherent work. Commit messages summarize individual changes; task records supply the deeper
account. Retain finished and canceled records, including cancellation reasons, as searchable history rather than
unfinished work.

Begin with a current human-reviewable overview; keep implementing-agent details below it. Explain why, what, and how,
with sufficient prose and useful visuals to assess the approach, verification, and remaining decisions. Keep detail
proportionate and avoid repeating the overview.

Plans adapt as questions are answered and work is discovered; skills own planning methods. Major-feature implementation
requires human approval of a concrete plan, renewed for material changes to its scope or constraints. Refinement and
small repairs within existing authorization do not require a new feature approval.

Shared states are Planned, Approved, Accepted, and Canceled. Approval authorizes the current plan; acceptance records
human satisfaction with the delivered outcome and evidence. Agent claims and passing checks do not establish acceptance.

Group coherent work without imposing a linear history. Create related or child tasks when work needs independent
planning, evidence, or scheduling. Nesting expresses ownership, dependencies express prerequisites, and queue order
expresses preference; none grants approval. Preserve those relationships in discovery views. Parent completion requires
its demonstrated outcome and accepted or canceled children. Relationships reference existing tasks, allow at most one
parent, and remain acyclic. Link related records rather than duplicating their details.

Record meaningful progress; task state remains authoritative over checklists, and acceptance requires completed steps.
Keep local execution progress separate from shared task records. Start only approved, selected work with satisfied
prerequisites. Within an authorized batch, verified implementation may satisfy execution dependencies before human
acceptance; shared completion requires accepted prerequisites.

Project reviews retain all substantiated material findings within scope, evidence, and proposed coherent follow-ups,
distinguishing unverified concerns and unexamined areas. Humans review proposals before follow-ups become approved work
and may reject, revise, or defer them. Backlog selection alone does not authorize implementation.

Capture personal feedback outside the repository. Triage records acceptance or rejection, reasons, and resulting record
references; unresolved feedback creates no project obligation. Keep record syntax and queue procedures in the records
guide.

Rationale: Adaptive plans preserve continuity without prematurely fixing the work breakdown. Concise overviews and
searchable evidence support human approval and acceptance without duplicating Git history or local execution state.
