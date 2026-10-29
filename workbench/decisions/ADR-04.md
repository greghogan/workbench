---
summary: Scoped identities, references, supporting files, schemas, migrations, and canonical formatting.
---

# ADR-4: Record contracts

Each record type defines its directory name (`record-type`), identifying code (`type-code`), file format, required
fields, and relationships.

Allocate nonnegative base-36 IDs monotonically per scope and record type. References use `<scope>:<type-code>-<id>`;
type codes are case-insensitive and IDs normalize to uppercase without leading zeroes. IDs in different scopes or types
establish no order. Each record has a canonical path; committed records and their paths are retained and never reused.
Adopted records may be removed through collection updates with explicit human approval of the reconciliation.

Store records under each scope's `workbench/<record-type>/`. Pad the base-36 ID to an even number of digits. Use every
pair except the final pair as nested directories, and the entire padded ID in `<TYPE-CODE>-<padded-id>.<extension>`.
Omit leading `00` directory levels; preserve interior `00` pairs. For example:

```text
record/REC-00.md
record/01/REC-0100.md
record/01/00/REC-010000.md
```

Every record type may reference other records. In prose, an omitted scope means the record's own scope; cross-scope
references name the owner. Structured relationships use fully qualified references. Commands resolve short IDs in the
selected project scope. Each type defines which relationships impose ordering or prohibit cycles; contextual citations
alone do not establish dependencies. Adopted records retain their collection namespace in the project-owned copy.

For every record type, keep committed supporting files in a sibling directory named after the record's filename without
its extension. The record identifies relevant supporting material. For example, `record/REC-00.md` owns
`record/REC-00/`. Neither path changes with status. Record types separately define storage for acquired and published
artifacts.

Reserve standard metadata fields for the record contract; place project-specific fields under `extensions`.

A root schema version identifies the configuration and record formats across registered project scopes, independently of
executable and collection revisions. Explicit migrations preserve record identities and policy meaning. Do not repeat
the version in individual records.

Formatting preserves values, comments, deliberate breaks, and embedded evidence while normalizing layout and reflowing
prose toward the configured width. It is deterministic and idempotent; unbreakable content and evidence may exceed the
width. Incomplete drafts remain formattable. Validation separately reports schema, reference, content, and formatting
problems without changing files. Creation formats its output; direct editing follows the same rules across registered
scopes.

Rationale: Stable identities preserve references as work evolves. Standard syntax and deterministic formatting limit
review noise, while separate validation supports drafts without weakening record contracts.
