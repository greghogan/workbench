---
summary: Treat the search index as disposable derived data with explicit freshness.
---

# ADR-2: Disposable search indexes

An index accelerates search but never replaces the [note files](ADR-00.md). Rebuild missing or invalid indexes from the
notes, preserve a usable prior result while rebuilding, and identify when a result may be stale.

Index corruption must not modify note files. Deleting generated cache data is safe while the application is stopped; the
next search rebuilds what it needs.

The [index comparison](../experiments/EXP-00.md) is an illustrative protocol, not a measured performance claim.

Rationale: Derived state can be replaced without creating another source of truth.
