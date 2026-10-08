---
summary: Authoritative sources, drift, executable docs.
---

# ADR-P: Documentation and knowledge integrity

Update user workflows, decisions, work records, and source ownership where a change affects them. Keep durable choices
and rationale in ADRs, commands and procedures in the README or skills, and implementation locations in source maps.

Maintain documentation for an identifiable reader, decision, or workflow; retained records also serve as historical
evidence.

Human and agent documentation share authoritative facts: manifests own versions, executable definitions own interfaces,
and check configuration owns quality limits. Secondary representations consume or derive from these sources, or are
checked against them. Useful repetition must not introduce independently maintained values.

Behavior changes include affected documentation in the same changeset. Validate executable examples, generated-file
freshness, references, and links; review agreement with decisions and behavior. Workbench and its language references
implement these requirements. Changes leaving documented behavior intact need no documentation edits.

Rationale: Keeping explanations near their authoritative sources reduces drift and makes agent context trustworthy.
