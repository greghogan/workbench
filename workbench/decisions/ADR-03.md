---
summary: Independent adoption of records and tools, consumer ownership, and self-contained guidance.
---

# ADR-3: Independent adoption of records and tools

The Workbench record conventions and collections can be adopted independently of its executable. Installing or updating
a tool does not adopt or replace project policy. Consumers own their configuration, records, agent guidance, and copied
automation; provider repository settings are not consumer defaults. Consuming applications retain their own language,
runtime, and distribution choices.

Adoption preserves existing project files and tool choices. Generated agent context reflects the project's selected
scopes, checks, and reconciled guidance. Committed records, maps, and agent guidance remain usable without the
executable or access to their upstream providers. Ordinary application builds must not require Workbench solely because
its record conventions were adopted.

Rationale: Independent adoption preserves consumer authority and makes useful records available without a dependency on
the tool or its providers.
