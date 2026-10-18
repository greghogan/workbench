---
summary: Project ownership, collection adoption, complete definition replacement, and scoped references.
---

# ADR-2: Project scopes and adopted material

Each registered project scope owns a human-written charter and records. Register a subproject for distinct intent or
records, not merely another language. Decisions apply to their scope and descendants, not siblings. Charters are not
inherited: adopting a collection does not adopt the provider's charter as governing authority, and a missing project
charter has no fallback.

Published collections have human-written charters stating their purpose and boundaries and governing their published
ADRs. A collection charter accompanies adopted records as context and provenance. The consuming project's charter
governs its adopted and adapted ADRs; the collection charter supplies no additional governing authority there.

Language check roots are independent of record scopes. A mixed-language project may share one records hierarchy across
several roots; manifest detection suggests roots, while configuration selects checks.

Adopted record collections become editable project-owned copies. Their current text states applicable policy; upstream
originals serve only as reconciliation inputs. Resolve policy conflicts by editing the affected records with human
review. Neither source order nor a separate overriding decision silently changes another decision's meaning.

Order ADRs from foundations to specializations. Within a namespace, references name only earlier ADRs. Cross-namespace
references name their owner, require applicability, and cannot introduce cycles. Namespaces preserve identity, not
policy precedence. Adopted namespaces add no governing charter or separate project registration.

Language definitions use complete replacement: select a complete project definition when present; otherwise use the
complete definition from the pinned executable distribution. Ignore the displaced definition without merging fields or
filling omissions. Inspection identifies selected sources. Project definitions can introduce new identities.

Copied automation, examples, and environment files become project-owned; updates do not implicitly replace them. Each
material's defining decision states whether it uses adopted copies, complete replacement, or no inheritance.

Rationale: Editable decisions keep current policy readable in place. Explicit scopes and complete definitions preserve
clear ownership without requiring agents to discover overrides.
