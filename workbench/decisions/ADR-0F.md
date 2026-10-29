---
summary: Purposeful documentation, authoritative definitions, and verified examples.
agent_instruction: Keep affected documentation and diagrams current with changes, using visuals where they clarify.
---

# ADR-F: Documentation sources and verification

Provide documentation proportionate to the project's size, risk, and audiences. Architecture and concept explanations
cover components, boundaries, important flows, constraints, domain terms, ownership, states, and relationships.
Getting-started and workflow guides provide tested paths from installation to useful results and worked examples of
common tasks. Reference documentation describes supported interfaces, configuration, schemas, and errors.

Contributor guidance explains development, testing, review, and extension. Operational guidance addresses deployment,
diagnostics, recovery, storage, and retention. Security and accessibility information explains trust boundaries,
controls, interaction methods, and known limitations. Release and migration guidance explains support, upgrades, and
compatibility changes. Cover these purposes where applicable, combining them when useful without requiring a separate
document for each.

Keep human-facing explanations and diagrams current with implementation changes. Use visuals where they clarify
structure, flows, relationships, or workflows. Curated source maps locate implementation for agents; they complement
rather than replace human-facing explanations. Link to authoritative explanations instead of maintaining duplicate
accounts.

Documentation that repeats facts defined by code or configuration is generated from or checked against those
definitions. This includes versions, command interfaces, and quality limits.

Validate runnable examples, links, and the freshness of generated documentation in normal quality gates. Review
explanatory prose against the decisions and behavior it describes.

Rationale: Readers need current explanations suited to their work. Proportionate coverage avoids unnecessary documents;
verified repetition remains consistent with authoritative definitions and actual behavior.
