---
summary: Operation ownership, shutdown, stale results, capacity limits, and responsiveness.
---

# ADR-H: Concurrency and resource ownership

Each background operation has an owner responsible for completion, cancellation, cleanup, or recovery handoff. Shutdown
defines how active work finishes, cancels safely, or transfers to recovery. Ownership ends only after cleanup completes
or responsibility is explicitly transferred.

Superseded results do not overwrite newer state. Owners remain responsible for those operations' effects and cleanup.

Bound queued and active work and the data retained for it, including buffered inputs and outputs. Define behavior when
capacity is exhausted. Status reporting, cancellation handling, and deadline enforcement remain responsive during
blocking work.

Rationale: Explicit ownership and capacity limits keep concurrent work accountable and responsive across shutdown and
overload.
