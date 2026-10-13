---
summary: Shutdown, cancellation, queues, memory bounds.
---

# ADR-H: Concurrency and resource ownership

Use structured ownership for background work. Shutdown cancels disposable reads and retains mutations until their
outcome or recovery obligation is recorded. Superseded operation results are ignored. Uncertain cleanup keeps resource
claims reserved.

Queues and worker concurrency have explicit bounds and overflow policies. Memory admission includes concurrent retained
buffers. Run blocking effects outside coordination locks so status, cancellation, and deadlines remain responsive.

Rationale: Ownership and bounds keep asynchronous work accountable without imposing a particular runtime or scheduler.
