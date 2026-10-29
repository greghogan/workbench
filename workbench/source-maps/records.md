# Records and knowledge

Record identity, metadata, references, generated context, and validation.

| Paths                                       | Responsibility                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/records.ts`                            | Creates and validates records and task or experiment relationships.                                              |
| `src/record-sequences.ts`                   | reserves record identities and retains allocation history.                                                       |
| `src/decisions.ts`                          | reads canonical decision metadata and validates applicable references without override precedence.               |
| `src/releases.ts`                           | creates release records and derives artifact indexes.                                                            |
| `src/maps.ts`                               | derives maps for all six record types and routes root maps to subprojects.                                       |
| `src/agents.ts`                             | derives shared root context and dynamic local context from charters and applicable decision records.             |
| `src/formatting.ts`                         | bundles canonical Markdown/JSON/YAML formatting and scopes batch operations to records and acquisition metadata. |
| `src/record-document.ts`                    | owns prose-record frontmatter, metadata schemas, and serialization.                                              |
| `src/documentation.ts`, `src/validation.ts` | own documentation and structural checks.                                                                         |
| `src/feedback.ts`, `src/commit.ts`          | stores local feedback in the platform data directory; `src/commit.ts` validates change-message policy.           |
| `src/cli/records.ts`                        | Consolidates record creation and citation acquisition with current-scope ID resolution.                          |
| `src/doc-examples.ts`                       | verifies executable console examples.                                                                            |
| `src/task-checklists.ts`                    | synchronizes linked child statuses and validates task completion checklists.                                     |
| `src/source-maps.ts`                        | Checks curated map paths, subsystem navigation, duplicates, and configured source coverage.                      |
| `src/citation-record.ts`                    | validates CSL-JSON records, acquisition state, and retained upstream metadata integrity.                         |
| `src/citations.ts`                          | imports identifier metadata and verifies source-specific PDF acquisition.                                        |

- `src/agent-review.ts`, `src/cli/agent-review.ts`: Captures complete Git snapshots, records agent review evidence, and
  enforces commit, publication, and human task-decision requirements.

- `src/record-creation.ts`: Reserve identities and publish formatted records with owned supporting files independently
  of kind-specific validation.

- `src/decision-record.ts`: Reads ADR metadata and validates reference ownership across body text and metadata.
- `tests/record_navigation.test.mts`: Verifies record-map navigation, metadata reference constraints, and actual
  protocol sections with isolated project scopes.
