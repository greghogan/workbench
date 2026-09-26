# ADR-J: Live services and durable state

Summary: Live-system changes preserve recovery, separate installation from activation, and expose destructive effects.

Keep installation, activation, migration, restart, and deletion separate. Inspect current state, preserve user
configuration, and identify recovery steps before changing durable state.

Live tests are explicit, bounded, and clean up their resources. Cleanup retains durable data unless deletion was
authorized.
