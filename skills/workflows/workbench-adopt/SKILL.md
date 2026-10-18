---
name: workbench-adopt
description:
  Adopt Workbench in an existing repository or migrate its integration; reconcile guidance, scopes, records, and checks
  into a reviewable change. Use for requested adoption or migration, not ordinary feature work.
---

# Workbench adoption

Read the executable distribution's adoption guide and the project's decision maps. Inspect existing agent guidance,
records, build roots, checks, and hooks before selecting changes. Existing practice is evidence to evaluate against the
requested choices, not policy to copy automatically. Keep a task for a migration that spans sessions.

Register scopes for distinct intent or records, and language roots for independent check boundaries. Reuse human-written
charters unchanged; identify missing charters for the human to supply. Do not infer or rewrite their intent. Reconcile
existing instructions into concise project decisions by editing the affected project-owned decisions. Keep procedures in
the README or skills and implementation locations in the source map.

Pin the requested Workbench revision and use its setup, sync, and validation commands. Preserve existing agent guidance
before replacing it with generated context, and preserve user-owned skills and hooks. Resolve conflicts explicitly; do
not silently discard instructions, disable existing checks, or add a `CLAUDE.md` adapter. Use one generated root
`AGENTS.md` and the user's selected local skill discovery links.

Configure the project's actual language roots and check commands; adapt executable references instead of copying
unneeded scaffolding. Preserve toolchain and environment pins unless their update is requested. Executable upgrades use
`workbench update` independently of collection reconciliation; never commit or discard user work to satisfy them.

Run structural validation and configured checks. Review the generated instructions, scope boundaries, discovery links,
and retained records. Report missing human input and unresolved policy choices precisely. Deliver the migration diff
without staging or committing unless requested; ADR and EXP changes retain their human-review requirement.
