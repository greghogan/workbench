# Commands and configuration

Route commands, validate configuration, and maintain project integration.

| Paths                                          | Responsibility                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/decision-record.ts`                       | reads decision text and metadata and normalizes owned and cross-source ADR references.                            |
| `src/config-schema.ts`                         | validates shared settings, automation, and registry keys and field types.                                         |
| `src/paths.ts`                                 | enforces portable project paths and rejects symlink redirection.                                                  |
| `src/invariants.ts`                            | checks parser/collection invariants and counts human-facing text.                                                 |
| `src/secrets.ts`                               | detects recognized credential formats without printing values.                                                    |
| `src/core.ts`                                  | owns project configuration, record identities, canonical paths, and safe file operations.                         |
| `src/projects.ts`                              | owns non-destructive setup, subproject registration, and Git hook configuration.                                  |
| `src/language-config.ts`                       | resolves shared language definitions, complete local replacements, and local additions.                           |
| `src/languages.ts`                             | inspects definitions, seeds reference roots, and verifies reference projects.                                     |
| `src/java-config.ts`                           | reads literal Java release targets and exact Temurin build pins.                                                  |
| `src/skills.ts`                                | validates skill metadata and invocation policy and maintains scoped root discovery for Codex and Claude.          |
| `src/input-errors.ts`                          | distinguishes invalid caller-owned data from unexpected implementation failures.                                  |
| `src/terminal-table.ts`                        | formats check, target, and configuration inspection tables.                                                       |
| `src/user-config.ts`                           | validates global machine settings and owns configuration inspection and updates.                                  |
| `src/config-command.ts`                        | exposes scoped human configuration while preserving agent-managed automation.                                     |
| `src/completion.ts`                            | derives shell completion from command definitions and global option metadata.                                     |
| `src/toolchains.ts`                            | reads native tool pins, resolves package-manager commands, and verifies tools inside check environments.          |
| `src/query-command.ts`                         | preserves literal query text after the command-line "--" separator.                                               |
| `src/main.ts`                                  | owns the hierarchical command interface and routing.                                                              |
| `.githooks/pre-commit`, `.githooks/commit-msg` | checks staged files and verifies the pinned Workbench checkout; `.githooks/commit-msg` validates change messages. |
| `src/review.ts`, `src/test-timing.ts`          | binds human acknowledgment to protected staged content; `src/test-timing.ts` reports advisory suite timing.       |
| `src/script-language-config.ts`                | reads native script-language support floors without executing project code.                                       |
