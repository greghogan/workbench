---
summary: Charter authority, human review, draft authority, and decision acceptance.
agent_instruction: Humans write charters and approve ADR additions, changes, and removals before commit.
---

# ADR-1: Decision records and authority

An Accepted Decision Record uses the `ADR` type code and states a durable choice, its applicability, and its rationale.
It uses Markdown with YAML frontmatter under `workbench/decisions/` and becomes accepted when committed after human
approval of its exact text. Draft decisions guide the current workspace so agents can implement and test them alongside
review.

Charters state human-written project intent. Decisions must conform to applicable charters and cannot amend or override
them. Resolve conflicts explicitly with the human.

Constrain intended outcomes and explain their rationale, assuming capable agents. State whether a decision governs
Workbench itself, adopting projects, or a selected optional practice. A particular mechanism belongs in a decision only
when choosing that mechanism is itself an intended durable constraint, with its rationale stated. Keep implementation
explanations in documentation and source maps, agent procedures in skills, and mechanically enforceable detail in
checks. Omit tutorials and general engineering advice. Group rules that share a rationale and change together. Split
independently applicable decisions, keeping shared requirements in a common decision and only differences in
specializations.

Other work requires human review only when a governing decision says so. Commit gates bind local acknowledgment to exact
protected staged changes, with human-authorship attestation for charters. Record it through interactive human review of
those contents; agents must not supply that approval. Protected edits invalidate acknowledgment; unrelated
implementation edits do not. This guards against accidental changes without authenticating authors or restricting file
access.

Rationale: Explicit authority and review boundaries preserve human control of durable choices while allowing agents to
develop and verify the implementation without waiting for acceptance.
