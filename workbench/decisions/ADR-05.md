---
summary: Scoped discovery and generated context.
agent_instruction: Read the listed decision maps after this file; open applicable ADRs before acting.
---

# ADR-5: Maps and agent context

Each record type has a map in its scope. Task maps list unfinished work; other record maps list all records. Records
remain authoritative; generated maps add no policy.

Source maps are project-owned explanations of implementation responsibilities and relationships. Keep a short
architectural entry point and split subsystem maps when useful. Describe files or directories at the granularity that
helps a reader locate a change; source code remains authoritative for behavior. Validate mapped paths, linked maps,
duplicate entries, and coverage of explicitly selected source roots. Exclusions are explicit; prose quality remains a
review responsibility. Exhaustive per-file descriptions and manually maintained counts are not required.

Every ADR has a title and concise routing `summary` naming details that help readers select it without repeating the
title. Include `agent_instruction` for rules needed before topic-specific reading. Other applicable decisions remain
binding even when their instructions are not copied.

Workbench generates one root `AGENTS.md` from project charters and current decision records, including drafts. It embeds
each project charter, copies selected instructions, preserves explicit overrides, labels each scope, and links decision
maps. An instruction retains its source scope. Agents read shared and root maps, then narrower maps relevant to their
work; they need not read every ADR.

Record maps and agent context derive from the same record metadata. Explicit synchronization updates generated files;
validation reports stale output without rewriting it. Existing unrelated agent guidance is preserved.

Tracked context is independent of machine-specific policies. It directs agents to read applicable local collection
context through Workbench before acting. Local context resolves installed records when read and does not rewrite shared
context or maps.

Apply ADR-1's integration mode: generated context references applicable decision records in the pinned distribution and
local scopes. It does not copy shared records into project ownership or acquire independent authority.

Rationale: One discoverable entry point supports agents that read only root context, while scoped routing limits
irrelevant detail and prevents local instructions from becoming global rules.
