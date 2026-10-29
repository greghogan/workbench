---
status: Approved
---

# TSK-8: Review and simplify the offline index

## Review summary

Review indexing and query behavior for correctness and unnecessary duplication. Keep the search-freshness evidence and
the [disposable-index decision](../decisions/ADR-02.md) as the constraints on any resulting work.

This fictional review groups related findings into two coherent refactors. The scenario assumes the developer reviewed
the log, selected the parsing/query separation and shared identity rules for implementation, and deferred speculative
caching until there is evidence that it is useful. The review's aggregated work remains open until both child outcomes
are accepted.

## Findings and decisions

- Repeated parsing can drift between query and rebuild paths. The selected follow-up is [demo:TSK-6](TSK-06.md), which
  waits for an existing behavioral baseline.
- Import and lookup paths need the same identity rules. [demo:TSK-B](TSK-0B.md) follows the parsing refactor and has
  separate reference and filename checks.
- An additional parse-result cache might help repeated queries, but no workload or measurement justifies it yet. Keep
  that idea here as a deferred proposal instead of creating an approved task.

These are demonstration findings about fictional Demonstration Project code, not findings about Workbench.

## Progress

- [ ] demo:TSK-6: Separate notebook parsing from index queries
- [ ] demo:TSK-B: Centralize note identity normalization

## Review boundary

The example covers note parsing, index queries, and recovery. It makes no claim about parser performance or the
accessibility findings that still require a representative reader session.
