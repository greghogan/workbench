---
summary: Accounts, SDK credentials, live-test limits.
---

# ADR-X: AWS boundaries

AWS operations expose account, region, endpoint, and resource ownership. Use the SDK credential chain and identify the
effective boundary in diagnostics without exposing credentials.

Routine tests use local substitutes. Live tests require explicit selection, cost and time bounds, ownership tags, and
cleanup. Destructive operations require exact targets and separate authorization.

Rationale: Explicit cloud boundaries reduce wrong-account effects, while local tests avoid routine cost and account
coupling.
