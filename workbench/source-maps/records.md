# Records and knowledge

Record identity, metadata, references, generated context, and validation.

| Paths                                                                   | Responsibility                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/records.ts`                                                        | Creates and validates records and task or experiment relationships.                                                |
| `src/record-sequences.ts`                                               | reserves record identities and retains allocation history.                                                         |
| `src/decisions.ts`                                                      | reads canonical decision metadata and validates applicable references without override precedence.                 |
| `src/releases.ts`                                                       | creates release records and derives artifact indexes.                                                              |
| `src/maps.ts`                                                           | derives maps for all six record types and routes root maps to subprojects.                                         |
| `src/agents.ts`                                                         | derives shared root context and dynamic local context from charters and applicable decision records.               |
| `src/formatting.ts`                                                     | bundles canonical Markdown/JSON/YAML formatting and scopes batch operations to records and acquisition metadata.   |
| `src/record-document.ts`                                                | owns record titles, prose frontmatter, metadata schemas, and serialization.                                        |
| `src/documentation.ts`, `src/validation.ts`                             | own documentation and structural checks.                                                                           |
| `src/feedback.ts`, `src/commit.ts`                                      | Stores local feedback; reads bounded commit text before Git's verbose diff and validates message policy.           |
| `src/cli/records.ts`                                                    | Consolidates record creation and citation acquisition with current-scope ID resolution.                            |
| `src/commit-history.ts`, `src/commit-workflow.ts`, `src/cli/commits.ts` | Own provisional commit markers, publication rejection, accepted review baselines, and the commit wrapper.          |
| `src/doc-examples.ts`                                                   | verifies executable console examples.                                                                              |
| `src/task-checklists.ts`                                                | synchronizes linked child statuses and validates task completion checklists.                                       |
| `src/source-maps.ts`                                                    | Checks curated map paths, subsystem navigation, duplicates, and configured source coverage.                        |
| `src/citation-record.ts`                                                | validates CSL-JSON records, acquisition state, and retained upstream metadata integrity.                           |
| `src/citation-html.ts`                                                  | extracts and sanitizes acquired webpage articles, embeds verified image formats, and compresses standalone copies. |
| `src/citations.ts`                                                      | orchestrates citation status, metadata import, and single or bulk document acquisition.                            |

- `src/agent-review.ts`, `src/cli/agent-review.ts`: Captures complete Git snapshots, records agent review evidence, and
  enforces local commit, outgoing-work review, and human task-decision requirements; pending agent receipts are replaced
  or consumed rather than retained as repository history. Branch task associations survive consumption and rebasing
  until publication is observed.

- `src/record-creation.ts`: Reserve identities and publish formatted records with owned supporting files; task graph
  validation and publication share the task mutation lock.

- `src/decision-record.ts`: Reads ADR metadata and validates reference ownership across body text and metadata.
- `tests/record_navigation.test.mts`: Verifies record-map navigation, metadata reference constraints, and actual
  protocol sections with isolated project scopes.

- `src/experiment-workflow.ts`, `src/cli/experiments.ts`: Track experiment execution and refinement, keeping human
  review of completed results independent of the candidate verdict.
- `src/review-formatting.ts`, `tests/review_formatting.test.mts`: Propose canonical formatting before review and apply
  only approved, unchanged inputs.
- `src/task-implementations.ts`: Share plan- and source-bound implementation evidence through Git repository identity
  while keeping worktree queues, active claims, and human decisions independent.

- `src/citation-format.ts`, `src/citation-dates.ts`: Define citation formats, byte limits, safe URLs, and shared date
  validation and presentation.
- `src/citation-acquisition.ts`, `src/citation-fetch.ts`: Own cancellable source acquisition, original and reader
  publication, per-record reconciliation, and rollback.
- `src/citation-integrity.ts`: Verifies regular-file descriptors and bounded decompression without buffering full
  documents.
