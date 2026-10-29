---
summary: Charter authority, human review, draft authority, and decision acceptance.
agent_instruction: Humans write charters and approve ADR additions, changes, and removals.
---

# ADR-1: Decision records and authority

An Accepted Decision Record uses the `ADR` type code and states a durable choice, its applicability, and its rationale.
Store ADRs as Markdown with YAML frontmatter under `workbench/decisions/`. Draft decisions guide the current workspace
so agents can implement and test them alongside review.

Charters state human-written project intent. Decisions must conform to applicable charters and cannot amend or override
them. Resolve conflicts explicitly with the human.

Constrain intended outcomes and explain their rationale, assuming capable agents. State which projects or scopes a
decision governs and whether it applies only when an optional practice is selected. A particular mechanism belongs in a
decision only when choosing that mechanism is itself an intended durable constraint, with its rationale stated. Keep
implementation explanations in documentation and source maps, agent procedures in skills, and mechanically enforceable
detail in checks. Omit tutorials and general engineering advice. Group rules that share a rationale and change together.
Split independently applicable decisions, keeping shared requirements in a common decision and only differences in
specializations.

Humans approve ADR additions, changes, and removals and attest to charter authorship. An ADR becomes accepted when its
approved text is committed. Other records require human review only when an applicable decision requires it.

Required human review covers the exact record contents and required supporting files presented for acknowledgment.
Agents must not supply human approval or charter-authorship attestation. Changing reviewed contents invalidates their
acknowledgment; unrelated implementation edits do not.

Required human review precedes commit. An explicitly marked provisional local commit is the only exception: it may
preserve records awaiting review as an unpublished checkpoint, without accepting them. Code gates and agent reviews
still apply. Complete required human review and consolidate or rewrite provisional history before publication.

Use the record's contents from the last commit not marked provisional as the baseline. If a newer human-reviewed version
exists, use the most recent reviewed version instead. If neither version exists, the baseline is empty. Provisional
commits do not advance it.

Rationale: Explicit authority and review boundaries preserve human control of durable choices while allowing agents to
develop and verify the implementation without waiting for acceptance.
