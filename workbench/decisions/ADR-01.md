---
summary: Scoped discovery and generated context.
agent_instruction: Read the listed decision maps after this file; open applicable ADRs before acting.
---

# ADR-1: Maps and agent context

Each record type has a map in its scope. Task maps list unfinished work; other maps list all records. Source maps
identify implementation responsibilities. Records remain authoritative; generated maps add no policy.

Every ADR has a title and concise routing `summary` naming details that help readers select it without repeating the
title. Include `agent_instruction` for rules needed before topic-specific reading. Other applicable decisions remain
binding even when their instructions are not copied.

Workbench generates one root `AGENTS.md` from project charters and current decision records, including drafts. It embeds
each project charter, copies selected instructions, preserves explicit overrides, labels each scope, and links decision
maps. An instruction retains its source scope. Agents read shared and root maps, then narrower maps relevant to their
work; they need not read every ADR.

Maps and agent context derive from the same record metadata. Explicit synchronization updates generated files;
validation reports stale output without rewriting it. Existing unrelated agent guidance is preserved.

Rationale: One discoverable entry point supports agents that read only root context, while scoped routing limits
irrelevant detail and prevents local instructions from becoming global rules.
