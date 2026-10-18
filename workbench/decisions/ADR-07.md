---
summary: Human review summaries, progress and child tasks, completion evidence, and local feedback promotion.
---

# ADR-7: Tasks and feedback

Task records use the `TSK` type code and are project-owned Markdown files with YAML frontmatter under
`workbench/tasks/`; they are not inherited. Record the outcome, status, current plan, material findings, and completion
evidence, adding detail as implementation approaches. Begin substantive tasks with a current prose review summary for
humans of the intended or delivered change, verification, and remaining decisions or limitations. Keep detailed plans
and evidence below it rather than repeating them.

Track meaningful steps with a progress checklist; the task's status remains authoritative. Create a child task when work
needs its own plan, evidence, dependencies, or lifecycle; replace duplicated parent detail with a reference. Each task
has at most one parent. Dependencies express ordering; reject missing relationships and cycles.

Inline checklist steps are agent-maintained. Linked child steps derive their checkbox and displayed status from the
child record: Done and Canceled are checked but remain distinguishable. Synchronization updates these links; validation
rejects stale, missing, or unrelated children and Done tasks with unchecked steps. Checklists neither replace structured
relationships nor automatically complete parents. A parent finishes only when its outcome is demonstrated and all
children are done or canceled.

Retain finished records while excluding them from active task maps; history remains searchable. Link related records
instead of copying them. Supporting files follow ADR-4 and may include reproduction fixtures or design assets; routine
logs are disposable. Relevant commit messages reference scoped task IDs; tasks need not name their own completion
commit.

Capture feedback in user data outside the repository. Explicit triage records acceptance or rejection with an
explanation and resulting record references; promotion may create a task or decision. Unresolved feedback creates no
project obligation. Keep checklist syntax and command procedures in the records guide.

Rationale: Progressive planning and concise summaries preserve continuity and human reviewability. Local feedback
captures observations without prematurely adding them to project commitments.
