---
summary: Generated record routing and instructions, curated source maps, and local context discovery.
agent_instruction: Read the applicable decision maps linked in AGENTS.md, then open the ADRs relevant to your task.
---

# ADR-5: Maps and agent context

Each record type has a map in its scope. Task maps list unfinished work; other record maps list all records. Records
remain authoritative; generated maps add no policy. ADR titles and concise routing summaries help readers select
decisions. Reserve `agent_instruction` for rules needed before topic-specific reading; other applicable rules remain
binding.

Source maps are project-owned explanations of implementation responsibilities and relationships. Keep a short
architectural entry point and split subsystem maps when useful. Choose file or directory granularity that helps locate
changes; source code remains authoritative. Validate mapped paths, linked maps, duplicate entries, and coverage of
explicitly selected source roots, with explicit exclusions. Prose quality requires review; exhaustive per-file
descriptions and manually maintained counts are unnecessary.

Generate one root `AGENTS.md` from scoped charters and current ADR metadata, including drafts. Embed charters, selected
instructions, scope labels, and decision-map links, preserving unrelated guidance. Agents read root and collection maps,
then applicable narrower maps.

Generated context references authoritative project-owned records, including adopted collection copies. Explicit
synchronization updates maps and context; validation only reports stale output.

Project context is committed and readable without Workbench. Keep local policy context separate, reflecting the current
approved selection, including an empty selection. Local entry points expose current decision maps and policy
fingerprints for review; shared project context contains portable discovery instructions. Machine-wide context updates
remain discoverable without rewriting each user's entry point. Keep generated-file locations and setup procedures in
guides.

Rationale: A discoverable entry point and scoped routing expose governing decisions without making every agent read
every record or turning local guidance into shared policy.
