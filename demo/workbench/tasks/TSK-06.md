---
status: Approved
parent: demo:TSK-8
depends_on:
  - demo:TSK-5
---

# TSK-6: Separate notebook parsing from index queries

## Review summary

The [index review](TSK-08.md) identified duplicated parsing during queries and index rebuilds. Give those operations one
parsing boundary while keeping note ownership, search results, and recovery behavior unchanged.

The task starts with an approved plan in this fictional scenario. Execution waits for the
[search-freshness checks](TSK-05.md), which establish the behavior the refactor must retain.

## Implementation details

- [ ] Identify the parsing inputs and the query/index callers.
- [ ] Consolidate the shared behavior without introducing a second note representation.
- [ ] Re-run edit, deletion, and index-rebuild checks.

## Validation

Compare observable results with the freshness cases before and after the refactor. This demonstration contains no
application implementation or measured result for this task.
