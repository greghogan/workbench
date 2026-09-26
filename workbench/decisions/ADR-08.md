# ADR-8: Semantic code boundaries

Summary: Organize code around owned state and invariants, considering consolidation as readily as extraction.

Modules follow cohesive state and invariants, not file-length quotas. Refactoring may split, join, move, or remove
code; length and churn prompt inspection but do not dictate a boundary. Avoid wrappers without a distinct contract.

Create a shared package for a stable boundary used by multiple consumers; keep consumer-specific models private.
