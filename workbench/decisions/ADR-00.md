---
summary: Human review, draft authority, scoped overrides, and references to earlier decisions.
agent_instruction: Humans write charters and approve ADR additions, changes, and removals before commit.
---

# ADR-0: Decision records and authority

An Accepted Decision Record (ADR) states a durable choice, its scope, and its rationale. It becomes accepted when
committed after human approval of its exact text. Draft decisions guide the current workspace so agents can implement
and test them alongside review; generating context does not constitute acceptance.

Record selected practices and rationale, assuming capable agents. Omit tutorials and general engineering advice; keep
mechanically enforceable detail in checks. Group rules that share a rationale and change together. Split independently
applicable decisions, keeping shared requirements in a common decision and only differences in specializations.

Order ADRs from foundations to specializations. Within a scope, an ADR may refer only to earlier ADRs; a later decision
states how it applies an earlier one. Remove circular dependencies by putting shared rules in the foundational decision.
References to inherited decisions use their owning scope; independent scope IDs do not establish cross-scope order.

Shared Workbench decisions apply to consumers; project decisions apply to their scope and descendants. A replacement
names the affected ADR in `overrides` and states the replacement rule, replacing only that rule within its scope.
Siblings retain inherited rules. Resolve conflicts explicitly; record order grants no precedence.

Decision records use integration: shared records remain referenced in the pinned distribution. Local decisions state
additions or scoped rule replacements without copying shared records into local ownership. Project charters are
human-written local intent and do not inherit the distribution's charter.

Charters are human-written; other work requires human review only when a governing decision says so. Commit gates bind
local acknowledgment to exact protected staged changes, with human-authorship attestation for charters. Agents record it
only after explicit human approval of those contents. Protected edits invalidate acknowledgment; unrelated
implementation edits do not. This guards against accidental changes without authenticating authors or restricting file
access.

Derived files need no separate human approval. Tasks and charters do not silently override decisions.

Rationale: Explicit authority and review boundaries preserve human control of durable choices while allowing agents to
develop and verify the implementation without waiting for acceptance.
