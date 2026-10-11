---
summary: Local capture, triage, promotion.
---

# ADR-8: Feedback before promotion

Feedback lives in the user's Workbench data directory outside the repository. Triage may promote it into a task or
decision.

`feedback resolve` records acceptance or rejection with an explanation and any resulting record references. Unresolved
feedback creates no project obligation.

Rationale: Low-cost capture preserves useful observations while keeping untriaged ideas out of the project commitment
queue.
