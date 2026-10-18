---
summary: Activation, migration, recovery, live tests.
agent_instruction: Preserve user data and active work; obtain explicit human authorization before destructive resets.
---

# ADR-V: Live service operations

Keep installation, activation, migration, restart, and deletion separate. Inspect current state, preserve user
configuration, and identify recovery steps before changing durable state.

Live tests are explicit, bounded, and clean up their resources. Cleanup retains durable data unless deletion was
authorized.

Persistence implementation follows ADR-G. Disabling backward compatibility alone does not authorize data deletion; a
data policy selected by a human under ADR-D can supply standing authorization within its scope.

Rationale: Separating live effects preserves recovery options and lets operators authorize the actual state transition.
