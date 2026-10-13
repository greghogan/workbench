---
summary: Activation, migration, recovery, live tests.
agent_instruction: Preserve user data and active work; destructive resets require explicit authorization.
---

# ADR-W: Live service operations

Keep installation, activation, migration, restart, and deletion separate. Inspect current state, preserve user
configuration, and identify recovery steps before changing durable state.

Live tests are explicit, bounded, and clean up their resources. Cleanup retains durable data unless deletion was
authorized.

Persistence implementation follows ADR-G; compatibility policy never substitutes for authorization to delete data.

Rationale: Separating live effects preserves recovery options and lets operators authorize the actual state transition.
