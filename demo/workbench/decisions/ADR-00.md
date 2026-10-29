---
summary: Keep Markdown notes authoritative and connect decisions to their supporting evidence.
agent_instruction: Preserve the distinction between demonstration records and actual project evidence.
---

# ADR-0: Notes stay in ordinary files

Keep decisions connected to the evidence that supports them.

Demonstration Project reads a user-selected folder of Markdown files. The files remain authoritative and can be edited
with any text editor. Browsing and search work locally without an account or a network connection. Generated indexes can
always be rebuilt from the notes.

Explore the [index experiment](../experiments/EXP-00.md), its [workstation environment](../environments/ENV-00.md), and
the [supporting citation](../citations/CIT-00.json). Hover or focus these links to preview their records.

Rationale: Plain files preserve ownership and keep the application useful alongside existing tools.
