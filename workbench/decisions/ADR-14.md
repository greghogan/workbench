---
summary: Optional container workspaces, shared native pins, and CI coverage.
---

# ADR-14: Dev Container development environments

Apply ADR-R. Dev Containers are optional Linux workspaces described by the standard specification and operated through
its CLI. Pin the environment image by digest and installation inputs deliberately. Reuse native tool pins, dependency
declarations, and configured commands; the container supplies the OS development prerequisites.

Local development retains changes in the working checkout. CI selects container coverage independently and shares one
container session across its selected roots. Native macOS and Windows checks remain separate compatibility evidence.
Opening an existing container does not authorize changing pins or rebuilding it destructively. Resource scheduling
follows ADR-U, including container creation and dependency preparation.

Rationale: A reusable workspace makes native prerequisites repeatable while keeping container tooling optional and
avoiding another language-version authority.
