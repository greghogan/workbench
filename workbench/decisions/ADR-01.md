# ADR-1: Workbench app, project scopes, and language roots

Summary: Registered scopes own records; language check roots can be selected independently.

Workbench manages setup, records, maps, generated agent context, citations, formatting, and validation. Command help
comes from the executable interface.

Each registered scope has a `workbench/` records directory. Register a subproject when it needs its own records, not
merely because it uses another language. The root alone has `AGENTS.md`; Workbench is a separate dependency at
`.workbench/` in consuming repositories.

Language check roots are configured independently of record scopes. A mixed-language project can use one records
hierarchy and several check roots. Manifest detection suggests roots; configuration decides which ones run.

The pinned Workbench dependency provides a Node bundle; setup writes project configuration without downloading or
building the app. Sync derives context after a human writes the charter; it does not overwrite unrelated agent guidance.
Validation is read-only.

The published Workbench command bundles its runtime dependencies in checked-in JavaScript. Its checks verify bundle
parity with source and lockfile; consumers need only a supported Node runtime.

Sync exposes only configured skills through harness-specific links. Codex sees the union of skills needed by registered
language roots at the repository root; Claude sees language skills in the applicable project directory. Skill text
checks the target scope before acting. Neither harness needs duplicate skill content.
