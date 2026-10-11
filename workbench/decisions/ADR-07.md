---
summary: Task hierarchy, completion, history, commit references.
---

# ADR-7: Plans and task continuity

A task records an outcome, state, current plan, material findings, and completion evidence. Plans gain detail as work
approaches implementation.

Begin substantive tasks with a short review summary for humans: the intended or delivered change, verification status,
and remaining decisions or limitations. Keep it current as work proceeds. Detailed plans, findings, and evidence follow
for agents and deeper review; the summary links to that evidence rather than repeating it. The summary is prose, not
additional task metadata or a substitute for completion evidence.

Use a progress checklist for meaningful steps that do not need an independent task lifecycle. Agents update these inline
steps as work and verification complete; the task's overall status remains authoritative. A separate child task is
appropriate when work needs its own plan, evidence, dependencies, or lifecycle.

A checklist item beginning with a scoped child-task reference, such as `- [ ] project:TSK-1: Description`, derives its
checkbox and status beside the reference from that child through `workbench sync`: checked means Done or Canceled, while
the status also distinguishes Planned, Active, and Blocked. Progress includes both inline steps and linked child tasks.
Other checklist items are maintained within the task. Validation rejects stale linked items, missing or unrelated
children, and Done tasks with unchecked steps. Checklists do not replace parent/dependency metadata or automatically
complete the parent.

Tasks are project-owned and are not inherited under ADR-1. Workbench's own tasks are ignored when resolving a consuming
project's task records.

Move independently actionable or verifiable work into a child task and replace the parent detail with a reference. Each
task has at most one parent; dependencies express ordering. Workbench rejects missing references and cycles.

A parent finishes only when its outcome is demonstrated and children are done or canceled. Link related records instead
of copying them. Retain completed and canceled task records; exclude them from the active task map and default record
queries, while allowing explicit history searches.

Commit messages reference scoped task IDs when relevant. Tasks may cite existing commits as evidence, but need not
contain the hash of their own completion commit.

Rationale: Progressive planning preserves continuity without spending attention on detail that may change before
execution.
