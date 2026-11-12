---
summary: Staged snapshot checks, reusable detailed results, coordinated gates, and cancellation.
---

# ADR-3: Check execution and reusable results

Workbench's CLI, hooks, and CI entry points apply the configured gates under workbench:ADR-U. Commit hooks check the
complete staged project snapshot without taking source from unstaged edits or untracked files. Snapshot preparation and
cleanup preserve the developer's working files and staged contents. Local environment preferences follow ADR-1.

Local CLI invocations and commit hooks can reuse successful check results under workbench:ADR-U. Fresh and reused runs
retain inspectable detailed results. Reports distinguish reused results from fresh verification and preserve the
original verification time. Record validation and required reviews remain independent of result reuse.

Concurrent gates for the same checkout wait for the active gate, then revalidate their selected inputs before reusing
results or executing. Independent checkouts can progress separately. Cancellation stops starting additional checks,
terminates the run's owned processes, and completes cleanup before releasing shared resources.

Retention of check output follows ADR-9.

Rationale: Reusing complete results avoids redundant execution across local development and commit checks. Isolated
staged snapshots, coordinated gates, and safe cancellation preserve the meaning of those results and protect active
work.
