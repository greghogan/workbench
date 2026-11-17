---
name: workbench-task-decisions
description:
  Prepare Workbench plan approvals or task outcome acceptances when the developer explicitly selects one or more
  items. Use for recording decisions, including revised plans, rather than evaluating a plan or implementation.
disable-model-invocation: true
---

# Workbench task decisions

Resolve the decision, project scope, and item identities from the developer's selection. Resolve positions against
the list the developer saw. If that list or the selection is unclear, ask which named plans or tasks they mean.

Inspect each named plan with `workbench task plan show NAME --json` or numbered task with
`workbench task show REF --json`. Present the selected titles and scoped references together. Use the review page
for a single item or prepare one `workbench task approve REF...` or `workbench task accept REF...` command for
terminal confirmation. Repeat `--expected DIGEST` once per reference, in the same order.

Leave confirmation to the developer in Workbench. If an item changed, identify it for review of the new version.
Report recorded decisions only after checking their resulting state.
