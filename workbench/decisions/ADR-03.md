---
summary: Base-36 IDs, stable paths, permanent retention.
---

# ADR-3: Record identity and references

Record IDs are nonnegative base-36 numbers allocated monotonically per scope and type. References use
`<scope>:<type>-<id>`; type names are case-insensitive and IDs normalize to uppercase without leading zeroes.

Each record has a canonical path independent of reference spelling. Directly authored records follow the same identity
rules. Committed records are retained, and their IDs and paths are never reused. Allocation reserves the next ID before
writing a record, so a failed or discarded draft may leave a gap. Required structured fields serve automation; record
prose preserves the context needed by readers.

Rationale: Stable identities let records, commits, and external discussions refer to the same work as its title, status,
and implementation evolve.
