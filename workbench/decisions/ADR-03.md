# ADR-3: Maps and context selection

Summary: Maps route readers to relevant records and source responsibilities without becoming new authority.

Each record type has a map in its scope. Task maps list unfinished work; other maps list all records. Decision maps
route readers to policy, and source maps route code ownership. Records remain authoritative.

Descriptions are authored in records. Workbench derives map identities, paths, and state; validation reports stale
maps without rewriting them.

Agents read `AGENTS.md` and the decision map, then open relevant records. Split maps by scope or responsibility when
needed.
