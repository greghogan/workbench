---
status: Accepted
added_at: 2026-11-16T13:02:20.279Z
---

# TSK-2: Separate plans, work, and reviews in the browser workflow

## Review summary

Replace the two workflow pages with three: **Plans**, **Work**, and **Reviews**. Give each phase a direct page and
count, keeping records available separately for browsing and search. Task acceptance includes its associated commits and
diffs; do not add a project-wide History page.

| Page    | Contents                                                             | Human decision                    |
| ------- | -------------------------------------------------------------------- | --------------------------------- |
| Plans   | Plans awaiting initial or revised approval                           | Approve the proposed work         |
| Work    | Approved available work and active or blocked execution              | Select and order work             |
| Reviews | Record and compatibility reviews; completed work awaiting acceptance | Review records or accept outcomes |

Keep task plan approval, implementation evidence, protected-record acknowledgment, and outcome acceptance distinct, even
when presented together. Apply existing record-review rules; this navigation change creates no new approval
requirements.

Move completed tasks and their pending record reviews into one entry in Reviews. Keep standalone record reviews directly
accessible. Start eligible work in queue order, giving started tasks priority when ready to resume. A started task
awaiting revised approval remains visible in Work and appears first in Plans.

An explicit project-review request authorizes scoped local work and appends it to the queue. Provide one version-bound
terminal confirmation for approving or accepting several selected items. Workflow lists update when their rows or counts
change. Browser notifications draw attention to new decisions with the developer's permission.

Retain the selected project or subproject, including its descendants, when navigating between pages. The root provides
the unified project view. Counts describe the same scoped set as their page; links, continuation, and next/previous
navigation preserve that context. Preserve existing per-commit review boundaries, approval baselines, and
concurrent-edit protection.

## Implementation account

Each workflow page shows counts for the selected project and loads long lists in batches. Work shows task IDs and links
to revised plans. Reapproval lets started work resume from its existing queue position. Reviews places pending document
links before the task outcome. Each review applies to the version presented.

The dashboard and workflow pages use the same rules. Lists refresh when visible items or counts change. The browser can
notify the developer of new decisions with permission. The task decisions skill prepares the selected versions for
terminal approval or acceptance. The project review skill records the developer's request as approval for the review
itself.

Pending review counts beside subproject names open their scoped Reviews pages. A parent count includes its descendants.
The root queue groups reviews by project, with the root first. A shared ADR delivered by an app task appears in that
task’s app section. The arrows visit each task’s pending documents before its outcome and keep the selected scope.
Confirming the last document opens the task outcome. Accepting it returns to the scoped Reviews queue.

Browser tests verified cross-scope document review and navigation through outcome acceptance.

## Implementing-agent detail

- Reconcile routes, navigation, workflow membership, counts, and document/task presentation around the three phases.
  Reuse the shared domain rules and review inventory rather than duplicating authority in page-specific queries.
- Keep consequential actions beside their owning item, with clear positive/negative choices and confirmations. Preserve
  independent record browsing and task-linked commit inspection during outcome acceptance.
- Exercise a complete plan-to-acceptance journey and document review across root and subproject scopes. Verify
  dependency changes, blocked work, revised plans, concurrent edits, cancellation, keyboard navigation, narrow layouts,
  empty states, and count consistency. Inspect the running interface before presenting the outcome for acceptance.
