# ADR-K: Terminal user interfaces

Summary: Terminal interfaces use explicit state, restore the terminal, and derive help from executable bindings.

Separate terminal state, updates, and rendering from side effects. Derive visible help from executable key bindings.

Test core interactions with in-memory events. Restore terminal state on every exit and failure path.
