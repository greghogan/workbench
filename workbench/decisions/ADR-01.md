---
summary: Integration and complete replacement, with independent document scopes and check roots.
---

# ADR-1: Project scopes and inheritance

Each registered project scope owns a charter and records. Register a subproject when it needs distinct intent or
records, not merely because it uses another language. A directory inherits decisions from its containing scopes; sibling
scopes do not govern one another.

Language check roots are configured independently of record scopes. A mixed-language project may have one records
hierarchy and several check roots. Manifest detection suggests roots; configuration selects their checks.

Consumers reference a pinned Workbench distribution separately from their own records and configuration. Inherited
material uses one of two modes:

## Integration

Shared and local material remain applicable together, retaining their source and scope. Local additions do not silently
hide shared material. Explicit scoped rule overrides follow ADR-0; unaffected shared rules remain applicable.

## Replacement

Select one complete definition for an identity. Use a local definition when present and ignore the corresponding shared
definition entirely; otherwise use the shared definition. Do not combine commands, merge fields, or fill omitted values
from the ignored definition. A complete local definition may introduce an identity absent from the distribution.

Each material's defining decision selects its inheritance mode or states that it is not inherited. Inspection identifies
applicable sources and selections. Updating the distribution changes inherited material; locally selected replacements
remain project-owned.

Copying a starter is separate from inheritance. A copy becomes project-owned and receives no implicit upstream updates.
Generated outputs preserve source provenance and acquire no independent authority.

Rationale: Integration preserves shared policy while replacement makes a selected definition understandable on its own.
Explicit ownership permits shared improvements without silently rewriting local choices. Independent document scopes and
check roots avoid duplicating records in mixed-language repositories.
