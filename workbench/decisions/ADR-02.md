---
summary: Separate record ownership from check roots.
---

# ADR-2: Project scopes and language roots

Each registered project scope owns a charter and records. Register a subproject when it needs distinct intent or
records, not merely because it uses another language. A directory inherits decisions from its containing scopes; sibling
scopes do not govern one another.

Language check roots are configured independently of record scopes. A mixed-language project may have one records
hierarchy and several check roots. Manifest detection suggests roots; configuration selects their checks.

Rationale: Document ownership and build boundaries often differ. Separating them supports mixed-language repositories
without duplicating charters or forcing their tools into the records hierarchy.
