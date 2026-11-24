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

Projects can declare complete inputs for reusable checks and their required setup. A complete gate can combine evidence
from independent check groups when their inputs match. Incomplete scopes use whole-project inputs. Fresh checks still
receive their required setup and outputs. Input declarations and selected source come from the same snapshot, and fresh
security checks retain their project-wide stability checks.

Scoped evidence requires execution in a qualified native environment that limits the check and its child processes to
the captured source, verified tools, and private writable outputs. Coverage comparisons use the committed baseline.
Unavailable isolation falls back to whole-project verification.

Acquire dependencies separately from builds and checks using the selected source snapshot. Linux builds and ordinary
checks use prepared inputs and isolate the network while retaining private loopback. Run live checks separately. macOS
permits networking for tests that use loopback. Windows uses whole-project inputs and the regular network environment.

Concurrent gates for the same checkout wait for the active gate, then revalidate their selected inputs before reusing
results or executing. Independent checkouts can progress separately. Cancellation stops starting additional checks,
terminates the run's owned processes, and completes cleanup before releasing shared resources.

Retention of check output follows ADR-9.

Rationale: Reusing complete results avoids redundant execution across local development and commit checks. Isolated
staged snapshots, coordinated gates, and safe cancellation preserve the meaning of those results and protect active
work.
