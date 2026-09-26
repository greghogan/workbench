# ADR-L: AWS boundaries

Summary: AWS integrations use supported configuration chains and isolate cloud effects from routine tests.

AWS operations expose account, region, endpoint, and resource ownership. Use the SDK credential chain and identify the
effective boundary in diagnostics without exposing credentials.

Routine tests use local substitutes. Live tests require explicit selection, cost and time bounds, ownership tags, and
cleanup. Destructive operations require exact targets and separate authorization.
