---
summary: Configuration authority, personal preferences, environment selection, and local inspection.
---

# ADR-1: Workbench configuration and commands

Shared configuration and storage principles follow workbench:ADR-I; terminal interaction follows workbench:ADR-W.
Projects own their settings and subproject declarations. Workbench's repository settings do not become consuming-project
defaults.

Keep resource and concurrency preferences personal, with Git-ignored checkout overrides. Optional shell integration
preserves existing customizations.

For local execution, environment selection follows this order: explicit command, active Workbench shell, ignored local
preference, then shared check default. Preferences cannot redefine commands, CI coverage, or generated shared context.
Staged checks retain local selection while reading commands and definitions from the proposed tree.

Provide scoped configuration editing and show effective values with their sources. Keep automation declarations
separate. Help, completion, and local configuration inspection work without project initialization or network access.

Rationale: Explicit authority and inspectable commands let personal choices vary without changing shared policy or the
work being verified.
