# ADR-2: Record identity and references

Summary: Scoped base-36 identifiers resolve to stable paths independently of their reference spelling.

Record IDs are nonnegative base-36 numbers allocated monotonically per scope and type. References use
`<scope>:<type>-<id>`; type names are case-insensitive and IDs normalize to uppercase without leading zeroes.

Records live at `<scope-records>/<type-plural>/<TYPE>-<ID>.<extension>`. Reference spelling does not change the path.

Directly authored records follow the same identity rules. Record formats require only fields consumed by automation.
Committed IDs and paths are never reused.
