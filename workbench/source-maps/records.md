# Records and knowledge

Record identity, metadata, references, generated context, and validation.

| Paths                                       | Responsibility                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/records.ts`                            | creates, opens, lists, searches, and validates records and task or experiment relationships.           |
| `src/record-sequences.ts`                   | reserves record identities and retains allocation history.                                             |
| `src/decisions.ts`                          | reads canonical decision metadata and validates scoped overrides.                                      |
| `src/releases.ts`                           | creates release records and derives artifact indexes.                                                  |
| `src/maps.ts`                               | derives maps for all six record types and routes root maps to subprojects.                             |
| `src/agents.ts`                             | derives shared root context and dynamic local context from charters and applicable decision records.   |
| `src/formatting.ts`                         | bundles canonical Markdown/YAML formatting and scopes batch operations to registered records.          |
| `src/record-document.ts`                    | owns prose-record frontmatter, metadata schemas, and serialization.                                    |
| `src/documentation.ts`, `src/validation.ts` | own documentation and structural checks.                                                               |
| `src/feedback.ts`, `src/commit.ts`          | stores local feedback in the platform data directory; `src/commit.ts` validates change-message policy. |
| `src/record-commands.ts`                    | defines record browsing and actions, shared query options, and current-scope ID resolution.            |
| `src/doc-examples.ts`                       | verifies executable console examples.                                                                  |
| `src/task-checklists.ts`                    | synchronizes linked child statuses and validates task completion checklists.                           |
| `src/source-maps.ts`                        | Checks curated map paths, subsystem navigation, duplicates, and configured source coverage.            |
| `src/citations.ts`                          | owns CSL YAML validation, identifier imports, and source-specific PDF acquisition.                     |
