# Commands and configuration

Route commands, validate configuration, and maintain project integration.

| Paths                                                                | Responsibility                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/decision-record.ts`                                             | reads decision text and metadata and normalizes owned and cross-source ADR references.                                 |
| `src/config-schema.ts`                                               | validates shared settings, automation, and registry keys and field types.                                              |
| `src/paths.ts`                                                       | enforces portable project paths and rejects symlink redirection.                                                       |
| `src/invariants.ts`                                                  | checks parser/collection invariants and counts human-facing text.                                                      |
| `src/secrets.ts`                                                     | detects recognized credential formats without printing values.                                                         |
| `src/core.ts`                                                        | owns project configuration, record identities, canonical paths, and safe file operations.                              |
| `src/projects.ts`                                                    | owns non-destructive setup, subproject registration, and Git hook configuration.                                       |
| `src/direnv.ts`                                                      | composes per-root direnv hooks, preserves personal shell settings, and watches resolved configuration and tool inputs. |
| `src/language-config.ts`                                             | resolves shared language definitions, complete local replacements, and local additions.                                |
| `src/languages.ts`                                                   | inspects definitions, seeds reference roots, and verifies reference projects.                                          |
| `src/java-config.ts`                                                 | reads literal Java release targets and exact Temurin build pins.                                                       |
| `src/skill-catalog.ts`                                               | Reads and fingerprints pinned definitions and computes project applicability and update differences.                   |
| `src/choice-tree.ts`                                                 | owns pure selection, tree navigation, expansion, disabled rows, and confirmation transitions.                          |
| `src/presentation.ts`                                                | resolves personal plain presentation and independent color suppression.                                                |
| `src/plain-choice.ts`                                                | presents complete numbered choices using shared selection rules and line-oriented input.                               |
| `src/terminal-choice.ts`                                             | adapts selection to terminal input, rendering, footer confirmation, cancellation, and restoration.                     |
| `src/skill-commands.ts`                                              | Inspects skills and updates user-wide preferences with conflict detection and explicit partial-success errors.         |
| `src/skill-ignores.ts`                                               | Maintains checkout-owned Git exclusion blocks without replacing user rules.                                            |
| `src/skills.ts`                                                      | Maintains ignored personal discovery links while preserving independently authored skills.                             |
| `src/input-errors.ts`                                                | distinguishes invalid caller-owned data from unexpected implementation failures.                                       |
| `src/terminal-table.ts`                                              | formats inspection tables with aligned quantities and optional group separators.                                       |
| `src/byte-size.ts`                                                   | formats decimal size estimates and exact byte counts used in enforced-bound diagnostics.                               |
| `src/user-config.ts`                                                 | validates global machine settings and owns configuration inspection and updates.                                       |
| `src/config-command.ts`                                              | exposes scoped human configuration while preserving agent-managed automation.                                          |
| `src/toml-edit.ts`                                                   | Applies checked TOML updates while retaining comments and untouched formatting.                                        |
| `src/completion.ts`                                                  | derives shell completion from command definitions and global option metadata.                                          |
| `src/toolchains.ts`                                                  | reads native tool pins, resolves package-manager commands, and verifies tools inside check environments.               |
| `src/query-command.ts`                                               | preserves literal query text after the command-line "--" separator.                                                    |
| `src/main.ts`                                                        | owns the hierarchical command interface and routing.                                                                   |
| `src/cli-help.ts`                                                    | groups and orders command discovery around user workflows.                                                             |
| `.githooks/pre-commit`, `.githooks/pre-push`, `.githooks/commit-msg` | Checks staged and outgoing commit trees using the selected executable; validates change messages.                      |
| `src/review.ts`, `src/test-timing.ts`                                | binds human acknowledgment to protected staged content; `src/test-timing.ts` reports advisory suite timing.            |
| `src/review-policy.ts`                                               | isolates staged policies for compatibility inspection and acknowledgment independently of human record approval.       |
| `src/staged-records.ts`                                              | Reads immutable Git trees and classifies project-owned records from staged and committed registrations.                |
| `src/record-retention.ts`                                            | protects canonical records in registered scopes, excluding exports and supporting files.                               |
| `src/script-language-config.ts`                                      | reads native script-language support floors without executing project code.                                            |

- `src/terminal-text.ts`: Sanitizes terminal controls and clips text at grapheme boundaries for progress displays.
