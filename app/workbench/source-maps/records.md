# Records and knowledge

- `src/core/records/records.ts`: Creates and validates records and task or experiment relationships.
- `src/core/records/record-sequences.ts`: reserves record identities and retains allocation history.
- `src/core/projects/project-paths.ts`: defines shared Workbench project-file paths.
- `src/core/records/decisions.ts`: reads canonical decision metadata and validates applicable references without
  override precedence.
- `src/core/records/releases.ts`: creates release records and derives artifact indexes.
- `src/core/records/maps.ts`: derives maps for all six record types and routes root maps to subprojects.
- `src/core/records/agents.ts`: derives shared root context and dynamic local context from charters and applicable
  decision records.
- `src/core/records/formatting.ts`: bundles canonical Markdown/JSON/YAML formatting and scopes batch operations to
  records and acquisition metadata.
- `src/core/records/record-document.ts`: owns record titles, prose frontmatter, metadata schemas, and serialization.
- `src/core/records/documentation.ts`, `src/core/records/validation.ts`: own documentation and structural checks.
- `src/core/feedback/feedback.ts`, `src/core/git/commit.ts`: Stores local feedback; reads bounded commit text before
  Git's verbose diff and validates message policy.
- `src/cli/records.ts`: Consolidates record creation and citation acquisition with current-scope ID resolution.
- `src/core/git/commit-history.ts`, `src/cli/commit-workflow.ts`, `src/cli/commits.ts`: Own provisional commit markers,
  publication rejection, accepted review baselines, and the commit wrapper.
- `src/core/records/doc-examples.ts`: verifies executable console examples.
- `src/core/tasks/task-checklists.ts`: synchronizes linked child statuses and validates task completion checklists.
- `src/core/records/source-maps.ts`: Checks curated map paths, subsystem navigation, duplicates, and configured source
  coverage.
- `src/core/citations/citation-record.ts`: validates CSL-JSON records, acquisition state, and retained upstream metadata
  integrity.
- `src/core/citations/citation-html.ts`: extracts and sanitizes acquired webpage articles, embeds verified image
  formats, and compresses standalone copies.
- `src/core/citations/citations.ts`: orchestrates citation status, metadata import, and single or bulk document
  acquisition.
- `src/core/review/agent-review.ts`, `src/cli/agent-review.ts`: Captures complete Git snapshots, records agent review
  evidence, and enforces local commit, outgoing-work review, and human task-decision requirements; pending agent
  receipts are replaced or consumed rather than retained as repository history. Branch task associations survive
  consumption and rebasing until publication is observed.
- `src/core/records/record-creation.ts`: Reserve identities and publish formatted records with owned supporting files;
  task graph validation and publication share the task mutation lock.
- `src/core/records/decision-record.ts`: Reads ADR metadata and validates reference ownership across body text and
  metadata.
- `test/core/records/record_navigation.test.mts`: Verifies record-map navigation, metadata reference constraints, and
  actual protocol sections with isolated project scopes.
- `src/core/experiments/experiment-workflow.ts`, `src/cli/experiments.ts`: Track experiment execution and refinement,
  keeping human review of completed results independent of the candidate verdict.
- `src/core/review/review-formatting.ts`, `test/core/review/review_formatting.test.mts`: Save canonical formatting
  before CLI or browser review; confirmation acknowledges retained contents without further file changes.
- `src/core/tasks/task-implementations.ts`: Share plan- and source-bound implementation evidence through Git repository
  identity while keeping active execution state separate from historical verification and human acceptance.
- `src/core/tasks/task-decisions.ts`: Store human task confirmations independently of execution queues, retain
  acceptance of distinct source snapshots, and recover interrupted decisions without overwriting newer human choices.
- `src/core/tasks/task-project-state.ts`: Resolve shared project state independently of branch or ancestry, with
  directory identity for projects without Git.
- `src/core/citations/citation-format.ts`, `src/core/citations/citation-dates.ts`: Define citation formats, byte limits,
  safe URLs, and shared date validation and presentation.
- `src/core/citations/citation-acquisition.ts`, `src/core/citations/citation-fetch.ts`: Own cancellable source
  acquisition, original and reader publication, per-record reconciliation, and rollback.
- `src/core/citations/citation-integrity.ts`: Verifies regular-file descriptors and bounded decompression without
  buffering full documents.
- `src/core/review/review-check.ts`, `src/core/review/review-approval.ts`: Enforce protected snapshot review and record
  exact acknowledgments independently of terminal presentation.

- `src/core/records`: Owns record identities, schemas, references, canonical formatting, maps, and generated agent
  context.

- `src/core/citations`: Imports bibliographic metadata and acquires, verifies, and serves preserved source documents.

- `src/core/tasks`: Tracks task relationships, human decisions, local queues, and implementation evidence.

- `src/core/tasks/planning/plan-model.ts`, `src/core/tasks/planning/planning-index.ts`: Define scoped named plans and
  index independent planning history without checking it out.
- `src/core/tasks/planning/planning-store.ts`, `src/core/tasks/planning/planning-operations.ts`: Retain durable drafts
  and exact approvals, and coordinate recoverable grouped checkpoints with concurrent editors.

- `src/core/experiments`: Tracks experiment execution and completed evidence independently of candidate verdicts.

- `src/core/review/review-preparation-state.ts`, `src/core/records/record-outputs.ts`: Track outstanding
  generated-output repair across interruption and update only outputs affected by prepared records.

- `src/core/records/archive-index.ts`, `src/core/records/archive-store.ts`: Reads pinned archive inventories and
  supporting blobs directly from Git and reconciles live copies without restoring them.
- `src/core/git/integration-target.ts`, `src/core/projects/project-state.ts`: Resolve the integration destination and
  coordinate archive metadata with record allocation.
- `src/core/records/archive-workflow.ts`, `src/core/records/archive-transfer-proof.ts`,
  `src/core/records/archive-publication.ts`: Coordinate recoverable transfers and verify storage-only commits and their
  publication dependencies.
- `src/core/git/archive-protection.ts`, `src/core/git/repository-state.ts`: Route existing hooks through durable
  repository-owned guards and coordinate writers across worktrees.
- `src/cli/record-archive.ts`: Presents archive previews, explicit transfers, recovery, and publication.
- `src/core/records/record-content.ts`, `src/core/records/record-projection.ts`: Share prose contracts and render maps
  from proposed live and archived Git contents without changing the checkout.

- `src/core/records/archive-hook.ts`: Supplies the bootstrap-compatible archive publication guard independently of an
  application checkout.
- `src/core/git/branch-integration.ts`, `src/cli/branch-integration.ts`: Capture rebase/merge targets, retain recovery
  references, and reconcile pinned inventories through explicit continuation or abortion.
- `src/core/git/tree-publication.ts`, `src/core/git/refs.ts`: Apply verified Git-tree transitions while preserving
  unrelated edits and centralize branch-name validation.
