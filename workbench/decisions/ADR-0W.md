---
summary: State, bindings, terminal restoration.
---

# ADR-W: Terminal user interfaces

Separate terminal state, updates, and rendering from side effects. Derive visible help from executable key bindings.

Test core interactions with in-memory events. Restore terminal state on every exit and failure path.

Rationale: Explicit state makes interactions testable, and reliable terminal restoration protects the surrounding
session.
