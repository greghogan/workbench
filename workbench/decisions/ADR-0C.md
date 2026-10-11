---
summary: Ownership, invariants, shared packages.
---

# ADR-C: Semantic code boundaries

Modules follow cohesive state and invariants, not file-length quotas. Refactoring may split, join, move, or remove code;
length and churn prompt inspection but do not dictate a boundary. Avoid wrappers without a distinct contract.

Create a shared package for a stable boundary used by multiple consumers; keep consumer-specific models private.

Rationale: Boundaries based on ownership make invariants easier to understand and change than boundaries based on file
size.
