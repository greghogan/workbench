# Commands and configuration

- `src/server/views/record-pane.tsx`: Shares adjacent-record navigation and document-pane controls across reading and
  review.
- `src/cli/rust-cache-command.ts`: Preview fresh owned Rust artifact selections and revalidate reviewed cleanup.
- `src/cli/tasks.ts`, `src/core/tasks/task-model.ts`, `src/core/tasks/task-service.ts`, `src/core/tasks/task-queue.ts`:
  Resolve task graphs, shared decisions, and atomic local queue progress across the CLI and web UI.
- `src/server/views/task-pages.tsx`, `src/server/browser/task-tree-client.ts`: Present nested plans, human task
  decisions, and the local execution queue.
- `src/core/projects/project-registry.ts`, `src/cli/project-admission.ts`, `src/core/projects/project-registration.ts`,
  `src/core/projects/project-requirements.ts`, `src/cli/projects.ts`: Track personal checkout approval, declared and
  verified tool requirements, and explicit project lifecycle commands, stable registered identities, and explicit
  relocation. Linked Git worktrees share dashboard navigation while retaining checkout-specific state.
- `src/cli/commands.ts`: Shares command admission metadata between bootstrap, help, and execution, including inherited
  worker admission. Validates overrides against the registered command tree and requires policy classification within
  mixed execution and inspection commands.
- `src/core/execution/environments/managed-installations.ts`: Records ownership of newly installed manager toolsets for
  conservative auto-pruning.
- `src/core/projects/project-cache.ts`, `src/core/storage/auto-prune.ts`: Bind reviewed cache cleanup to ownership and
  registration, and retire superseded owned assets after verified replacement checks.
- `src/cli/pager.ts`: Page long interactive help while preserving complete noninteractive output and terminal state.
- `src/server/projects/project-hub.ts`, `src/server/projects/hub-lifecycle.ts`, `src/server/views/hub-pages.tsx`,
  `src/server/routes/project-paths.ts`, `src/server/projects/project-mounts.ts`: Serve project navigation and cache
  maintenance through one local origin, with scoped routes, typed renderers, resource admission, idle view eviction, and
  draining shutdown.
- `src/server/cache/cache-worker.ts`, `src/server/cache/cache-protocol.ts`, `src/server/cache/cache-inventory.ts`,
  `src/server/cache/inventory-service.ts`: Validate maintenance protocols and publish component metadata before
  persistent size measurements.
- `src/core/storage/cache-generation.mts`: Persist size estimates separately from writer-owned invalidation markers,
  without using estimates as deletion authority.
- `src/core/storage/bounded-state.ts`: Apply the same decoding and byte limits to state reads and writes, with bounded
  retries for transient replacement during a read.
- `src/server/browser/reference-client.ts`: Show accessible record-reference previews without changing link navigation.
- `src/server/browser/diagram-client.ts`, `src/server/browser/diagram-renderer.ts`, `src/server/http/diagram-asset.ts`,
  `resources/browser`: Render local Mermaid diagrams in an isolated frame, display inert images, and preserve readable
  source during failure and review.
- `src/server/browser/card-client.ts`: Add card navigation while preserving ordinary links, text selection, and
  controls.
- `src/server/browser/hub-client.ts`: Refresh asynchronously calculated cache inventory without replacing navigation or
  drafts.
- `src/server/demo/demonstration.ts`, `src/server/demo/demonstration-story.ts`, `src/server/projects/demo-service.ts`:
  Assemble a disposable consuming project from packaged, readable demonstration data.
- `src/core/configuration/config-schema.ts`: validates shared settings, automation, and registry keys and field types.
- `src/core/runtime/paths.ts`: enforces portable project paths and rejects symlink redirection.
- `src/core/runtime/invariants.ts`: checks parser/collection invariants and counts human-facing text.
- `src/core/runtime/secrets.ts`: detects recognized credential formats without printing values.
- `src/core/projects/project-model.ts`, `src/core/projects/project-context.ts`,
  `src/core/projects/project-configuration.ts`, `src/core/records/record-identity.ts`,
  `src/core/records/record-files.ts`, `src/core/runtime/files.ts`: Separate project declarations, checkout resolution,
  validated configuration, record identity/discovery, and file reads.
- `src/core/projects/projects.ts`: owns non-destructive setup, subproject registration, and Git hook configuration.
- `src/core/execution/environments/direnv.ts`: composes per-root direnv hooks, preserves personal shell settings, and
  watches resolved configuration and tool inputs.
- `src/core/configuration/language-config.ts`: resolves shared language definitions, complete local replacements, and
  local additions.
- `src/core/toolchains/languages.ts`: inspects definitions, seeds reference roots, and verifies reference projects.
- `src/core/toolchains/java-config.ts`: parses literal root Maven properties with SAXes and validates exact Temurin
  build pins.
- `src/core/skills/skill-catalog.ts`: Reads and fingerprints pinned definitions and computes project applicability and
  update differences.
- `src/cli/terminal/choice-tree.ts`: owns pure selection, tree navigation, expansion, disabled rows, and confirmation
  transitions.
- `src/core/diagnostics/presentation.ts`: resolves personal plain presentation and independent color suppression.
- `src/cli/terminal/plain-choice.ts`: presents complete numbered choices using shared selection rules and line-oriented
  input.
- `src/cli/terminal/terminal-choice.ts`: adapts selection to terminal input, rendering, footer confirmation,
  cancellation, and restoration.
- `src/cli/skills.ts`: Inspects skills and updates user-wide preferences with conflict detection and explicit
  partial-success errors.
- `src/core/skills/skill-ignores.ts`: Maintains checkout-owned Git exclusion blocks without replacing user rules.
- `src/core/skills/skills.ts`: Maintains ignored personal discovery links while preserving independently authored
  skills.
- `src/core/runtime/input-errors.ts`: distinguishes invalid caller-owned data from unexpected implementation failures.
- `src/core/diagnostics/terminal-table.ts`: formats inspection tables with aligned quantities and optional group
  separators.
- `src/core/runtime/byte-size.ts`: formats decimal size estimates and exact byte counts used in enforced-bound
  diagnostics.
- `src/core/configuration/user-config.ts`: validates global machine settings and owns configuration inspection and
  updates.
- `src/core/configuration/config-command.ts`: exposes scoped human configuration while preserving agent-managed
  automation.
- `src/core/configuration/toml-edit.ts`: Applies checked TOML updates while retaining comments and untouched formatting.
- `src/cli/completion.ts`: derives shell completion from command definitions and global option metadata.
- `src/core/toolchains/toolchains.ts`: reads native tool pins, resolves package-manager commands, and verifies tools
  inside check environments.
- `src/cli/query-command.ts`: preserves literal query text after the command-line "--" separator.
- `src/cli/main.ts`, `src/cli/program.ts`: separates worker dispatch from command registration and owns CLI composition.
- `src/cli/help.ts`: groups and orders command discovery around user workflows.
- `src/cli/review.ts`, `src/core/execution/checks/test-timing.ts`: binds human acknowledgment to captured current-file
  contents independently of staging; app/src/core/execution/checks/test-timing.ts reports advisory suite timing.
- `src/core/review/review-policy.ts`: isolates staged policies for compatibility inspection and acknowledgment
  independently of human record approval.
- `src/core/records/staged-records.ts`: Reads immutable Git trees and classifies project-owned records from staged and
  committed registrations.
- `src/core/records/record-retention.ts`: protects canonical records in registered scopes, excluding exports and
  supporting files.
- `src/core/configuration/script-language-config.ts`: reads native script-language support floors without executing
  project code.
- `src/core/diagnostics/terminal-text.ts`: Sanitizes terminal controls and clips text at grapheme boundaries for
  progress displays.
- `src/core/projects/project-hierarchy.ts`: Resolves display names, registered parent scopes, and name-based breadcrumbs
  for the UI and CLI, reusing the hierarchy within each workspace view.
- `src/server/views/source-navigation.tsx`, `src/server/browser/source-client.ts`: Render project and collection
  navigation and own accessible branch disclosure.
- `src/core/records/record-service.ts`: Discovers browsable project and collection records, lists owned supporting
  files, and saves human edits with content-version checks.
- `src/core/review/review-service.ts`: Inspects working and staged changes, merges independent per-file human
  acknowledgments, and retains the latest reviewed record contents for comparison without making current-file approval
  depend on staged declarations.
- `src/server/review/review-worker.ts`: Owns off-listener approval validation and receipt publication; admitted work
  drains before shutdown completes.
- `src/server/http/server.ts`: Owns the loopback listener, request boundaries, browser actions, live connections, and
  shutdown.
- `src/server/review/review-versions.ts`: Retains bounded immutable presentations so browser acknowledgments identify
  the shown version even after a disk edit, independently of the current workspace snapshot.
- `src/server/review/review-queue.ts`: Owns review groups, pending counts, navigation, and confirmation continuation,
  with the main project before its subprojects and collections.
- `src/server/views/pages.tsx`, `src/server/views/render-links.tsx`, `src/server/views/components.tsx`,
  `src/server/browser/style.css`: Present records, review snapshots, collection proposals, safe Markdown, accessible
  source differences, and Catalog-inspired styling.
- `src/server/views/record-pages.tsx`, `src/server/views/review-page.tsx`, `src/server/review/review-model.ts`,
  `src/server/views/collection-pages.tsx`, `src/server/views/charter-pages.tsx`,
  `src/server/views/collection-summary.tsx`: Own feature rendering and exact review-version preparation.
- `src/server/views/page-document.tsx`, `src/server/views/page-frame.tsx`, `src/server/workspace/view-context.ts`,
  `src/server/browser/styles`: Compose the typed document and project frame with shared presentation context and CSS.
- `src/server/views/markdown-view.tsx`, `src/server/views/record-content.tsx`, `src/server/views/record-links.tsx`,
  `src/server/views/diff-view.tsx`: Own safe Markdown, metadata and record lists, record-reference previews, and diff
  presentation. ESLint confines raw HTML to the escaped Markdown renderer.
- `src/core/records/record-lookup.ts`: Builds snapshot-owned indexes for normalized identities, absolute record paths,
  and owned supporting-file roots, preserving source boundaries and lookup precedence.
- `src/server/views/action-forms.tsx`, `src/server/routes/locations.ts`, `src/server/routes/record-page-model.ts`:
  Require typed mutation targets and versions, construct scoped route queries, and validate record view capabilities
  before presentation.
- `test/fixtures/dom.mts`, `test/server/views/web_render_lint.test.mts`, `test/server/views/web_components.test.mts`:
  Own and close presentation DOMs, verify configured rendering/accessibility lint enforcement, and compare initial and
  live cache rows.
- `test/server/views/web_forms.mts`, `test/server/cache/web_cache_view_model.test.mts`: Share static JSX enforcement,
  verify rejected form/route declarations during typechecking, and compare inventory indexes against independent scans.
- `src/server/routes/navigation-state.ts`, `src/server/http/error-response.ts`, `src/server/projects/recovery.ts`,
  `src/server/http/response-problem.ts`, `src/server/workspace/workspace-codec.ts`, `src/server/cache/size-protocol.ts`,
  `src/server/cache/inventory-protocol.ts`: Validate route choices, preserve navigation context, and decode typed
  service data.
- `src/server/cache/cache-view-model.ts`, `src/server/cache/cache-quantity.ts`,
  `src/server/cache/cache-measurements.ts`: Prepare cache ownership rows, share quantity states, and bound concurrent
  directory measurements.
- `src/server/browser/focus.ts`: Restores keyboard focus to the same record or navigation context after live
  publication.
- `src/server/browser/client.ts`, `src/server/browser/assets.ts`, `src/server/browser/asset-manifest.ts`: Enhance
  server-rendered pages with live updates, protected drafts, and browser actions; the asset module is generated from
  browser TypeScript and authored CSS by the tooling build.
- `src/server/workspace/live.ts`: Reconciles filesystem changes and Git state, watches relevant directories, and reports
  revisions.
- `src/server/review/diff.ts`: Compare current record contents with acquired review and collection baselines.
- `src/server/review/comparison-result.ts`: Keeps each acquired comparison independent from document availability and
  other baselines.
- `src/server/workspace/workspace-problem.ts`: Shares safe workspace freshness messages with browser controllers.
- `src/server/review/review-navigation.ts`: Preserve record order and layout while retaining independent file reviews.
- `src/server/views/breadcrumbs.tsx`: Links declared project names and page ancestors without repeating the current
  heading.
- `src/server/review/document-comparison.ts`, `src/server/review/block-alignment.ts`,
  `src/server/review/comparison-budget.ts`, `test/server/review/web_diff.test.mts`,
  `test/server/review/document_comparison_properties.test.mts`: Use Markdown block boundaries, weighted global sequence
  alignment, word-order-aware similarity, a shared fine-comparison allowance, and pinned jsdiff matching to compare
  logical paragraphs and group nearby word edits around unchanged sentences. Preserve wrapping-independent matches and
  literal-source whitespace; exhausted alignment shows separate complete removals and additions. Generated
  transformations check reconstruction, and exhaustive small alignments provide an independent oracle.
- `src/server/projects/collection-service.ts`, `src/server/projects/collection-runner.ts`: Share verified collection
  preview/application with CLI reconciliation and keep acquisition outside the HTTP listener.
- `test/server/review/web_reviews.test.mts`, `test/server/http/web_server.test.mts`,
  `test/server/projects/web_collections.test.mts`, `test/fixtures/web.mts`: Verify independent approvals, stale edits,
  browser boundaries, live updates, owned files, and exact collection plans.
- `src/core/storage/browser-evidence.ts`: Owns binary artifact manifests and producer lifetimes separately from fixture
  scratch and text logs. Plans and revalidates retention using each project's policy, recovers proven abandoned runs,
  and preserves uncertain evidence.
- `src/core/records/record-metadata.ts`: Derives readable citation summaries and metadata labels without weakening
  record validation.
- `src/server/routes/sources.ts`, `src/server/routes/record-listing.ts`: Separate selected record sources and provide
  stable incremental list ordering and cursors.
- `src/server/review/collection-comparison.ts`: Compares adopted ADRs with verified pinned originals, including
  committed adaptations and removals, without implicit acquisition.
- `test/server/views/web_presentation.test.mts`: Verifies source isolation, upstream comparisons, readable metadata,
  citation details, stable batches, and stale-list detection.
- `src/server/workspace/workspace-service.ts`, `src/server/workspace/workspace-worker.ts`: Acquire complete workspace
  snapshots off the listener and index records, reviews, collection comparisons, and document contents for interface
  queries.
- `src/core/projects/workspace-inputs.ts`, `src/server/documents/citation-freshness.ts`: Track captured Git,
  configuration, record, and document inputs; allow verified citation reads independently of unrelated refreshes.
- `src/server/http/content-negotiation.ts`: Negotiate acceptable HTTP representations.
- `src/core/execution/ci/support/ci-browser-timings.mts`: Summarize retained browser timing evidence without historical
  comparisons or timing gates.
- `src/server/browser/browser-session.ts`, `src/server/browser/live-client.ts`, `src/server/browser/list-client.ts`,
  `src/server/browser/form-client.ts`: Coordinate live publication, protected drafts, per-file review refresh, bounded
  incremental windows, forms, navigation, and cleanup.
- `src/server/http/http.ts`, `src/server/http/errors.ts`, `src/server/projects/actions.ts`,
  `src/server/http/downloads.ts`: Own HTTP boundaries, explicit error meanings, admitted mutations, expiring proposals,
  and streamed descriptor lifetimes.
- `src/server/routes/record-window.ts`: Defines shared query and browser window bounds.
- `src/server/projects/protocol.ts`: Decode collection worker requests and verified preview shapes before use.
- `src/core/diagnostics/diagnostics.mts`: Preserve bounded cause graphs, render versioned diagnostic events, redact
  credentials, and capture output with explicit omissions.
- `src/core/diagnostics/diagnostic-contract.mts`: Define shared typed diagnostic operations, outcomes, severities,
  formats, and states without runtime-specific dependencies.
- `src/core/diagnostics/diagnostic-session.ts`: Own optional persistent diagnostic sessions and report sink failures and
  omissions. `src/core/diagnostics/diagnostic-issues.ts` shares bounded issue retention and omission accounting.
- `src/core/diagnostics/diagnostic-text.mts`: Share credential grammar, UTF-8 limits, streaming redaction, bounded
  capture, and retained-stream draining. Wrap diagnostic prose while preserving indivisible values and source-frame
  alignment, without changing JSON records; startup uses a dependency-free width estimate and the CLI supplies Unicode
  display widths.
- `src/core/diagnostics/diagnostic-errors.mts`: Normalize, render, and decode bounded error graphs with process
  termination evidence and combined cleanup failures.
- `src/core/diagnostics/diagnostic-writer.mts`: Bound observational writes and report dropped events and sink errors
  consistently.
- `src/core/diagnostics/diagnostic-records.mts`: Sanitize canonical JSONL as bounded records so quoted diagnostic text
  remains independently parseable during retention and reading.
- `src/core/diagnostics/diagnostic-options.ts`: Resolve flags, environment controls, and saved diagnostic preferences
  without mutation.
- `src/server/routes/routes.ts`, `src/server/workspace/workspace-protocol.ts`: Own typed HTTP resource paths, query
  contracts, action effects, and workspace messages.
- `test/core/diagnostics/diagnostic_contracts.test.mts`: Verify shared vocabulary, pure option precedence, normalized
  rendering, redaction boundaries, sink accounting, and child severity preservation.
- `src/server/http/observability.ts`: Correlate requests, report stream failures, and collect fixed-cardinality service
  metrics.
- `test/core/diagnostics/diagnostics.test.mts`, `test/core/diagnostics/diagnostic_cli.test.mts`,
  `test/server/http/web_observability.test.mts`: Verify diagnostic contracts, transport, redaction, bounded capture,
  HTTP correlation, mutation outcomes, and capacity observations.
- `src/server/documents/citation-documents.ts`: Serve bounded, digest-verified PDF views and downloads from the owned
  citation library, using the citation service's source-specific local presence.
- `test/server/documents/web_citations.test.mts`, `src/core/verification/document-fixtures.mts`: Verify citation
  availability, streamed byte ranges, document integrity, and native PDF viewing with an offline document fixture.
- `test/integration/browser/web-browser-scenarios.mts`: Define named shipped-browser workflows and retain advisory
  document loading timings, verifying warm asset reuse, concurrent review reads, and invalidation after edits.
- `test/server/browser/web_client.test.mts`, `test/server/projects/web_protocol.test.mts`: Verify asynchronous draft
  protection, focus-preserving window bounds, and cleanup.
- `src/cli/initialization.ts`, `src/core/projects/project-edits.ts`: Plan and apply new-project or existing-project
  adoption, reject conflicts before publishing files, and preserve consumer-owned automation and integrations.
- `src/core/records/markdown-links.ts`: Encodes generated destinations, extracts actual links, and relocates embedded
  links while preserving authored text and literal examples.
- `test/cli/initialization.test.mts`, `test/core/records/markdown_links.test.mts`,
  `test/server/projects/web_onboarding.test.mts`: Verify all language starters, preservation and preflight behavior,
  link targets, human charter creation, and cross-source review reminders.
- `src/core/runtime/file-reads.ts`, `src/core/runtime/file-publication.mts`: Read regular files through bounded
  descriptors and publish complete staged batches with preflight and final per-file preconditions and explicit cleanup
  failures.
- `src/core/runtime/directory-publication.mts`: Replace privately prepared directories, restore previous output on
  failure, and retain recovery paths when rollback fails.
- `src/core/git/git-snapshot.ts`: Capture committed files and optional staged changes with bounded immutable blob
  acquisition for commit gates and current-record workspace views; batch policy and task requests and deduplicate
  immutable blob reads.
- `src/cli/cache.ts`, `src/core/storage/cache-plan-identity.ts`: Keep terminal interaction separate from cache services
  and bind cleanup approval to ownership, writer generations, and protections independently of size measurements.
- `test/core/git/git_snapshot.test.mts`, `test/core/records/record_allocation_lock.test.mts`,
  `test/core/storage/cache_cancellation.test.mts`, `test/server/workspace/workspace_supervision.test.mts`,
  `test/core/records/record_metadata.mts`: Verify publication, bounded acquisition, snapshot consistency, lock recovery,
  subprocess draining, read-worker supervision, and kind-specific record contracts.
- `src/core/collections/policy-state.ts`: Decode bounded local-policy provenance and project/local reconciliation
  receipts before use.
- `src/core/configuration/configuration-snapshot.ts`: Own immutable configuration acquisition for one operation, with
  fresh boundaries for later and proposed-tree operations.
- `src/core/projects/project-identity.ts`: Separate portable scope identifiers from registered directory paths and
  display names.
- `test/integration/browser/web-accessibility.mts`: Collect automated browser accessibility evidence and retain
  unverified assessment boundaries.
- `src/core/diagnostics/terminal-output.ts`: Sanitize terminal output independently of display-width libraries,
  preserving the Node 18 bootstrap boundary.
- `src/cli/tool-profile-output.ts`: Render tool-profile listings without coupling verified bootstrap acquisition to
  terminal rendering.
- `src/server/workspace/worker-generation.ts`: Pin worker code for each listener lifetime and release it after draining.
- `src/core/review/review-snapshot.ts`, `src/server/review/review-status.ts`: Validate presented bytes and lightweight
  version-status replies.
- `src/server/review/document-comparison-model.ts`: Prepare immutable comparison decisions separately from rendered
  markup.
- `src/core/records/markdown-excerpt.ts`: Extract readable prose for shared record previews.
- `src/core/collections/policy-findings.ts`, `src/server/views/compatibility-review.tsx`: Retain concrete policy
  contradictions and exact human resolution decisions, and include pending incompatibilities in the unified document
  review workflow.
- `src/server/http/http-listener.ts`: Apply loopback endpoint validation, transport limits, diagnostics, and listener
  startup/closure consistently to project and hub services.
- `src/server/views/experiment-pages.tsx`: Presents experiment execution, candidate verdicts, and completed evidence for
  human review.
- `test/server/projects/demo_service.test.mts`, `test/server/demo/demonstration_resume.test.mts`,
  `test/core/projects/project_relocation.test.mts`, `test/server/projects/web_recovery.test.mts`: Exercise demonstration
  child failure and recovery, retained cache measurements, visible protocol failures, and navigational recovery after
  rejected mutations.
- `src/server/views/citation-original.tsx`: Renders trusted document controls around a sandboxed original-source frame
  with explicit remote-image selection.
- `src/server/workspace/review-preparation.ts`: Reports formatting needs from captured review bytes without changing the
  file or its identity. Review actions save canonical formatting before presenting the actual file.
- `src/server/review/review-request.ts`, `src/server/review/review-protocol.ts`, `src/server/review/review-state.ts`:
  Validate preparation targets and worker operations while keeping preparation separate from exact acknowledgment.
- `src/server/http/asset-response.ts`, `test/server/browser/web_assets.test.mts`: Serve content-versioned static
  resources with immutable browser caching, negotiated compression, and representation-specific conditional requests.
- `src/cli/development-selection.ts`, `src/cli/server.ts`, `src/cli/project-setup.ts`,
  `src/cli/collection-confirmation.ts`, `src/cli/terminal/project-prompt.ts`: Compose commands, server lifecycle,
  interactive project setup, and collection acceptance around shared services.
- `src/server/workspace/worker-entry.ts`: Dispatch cache, review, and workspace workers without constructing the command
  parser.
- `src/server/projects/project-reviews.ts`, `src/server/projects/review-inventory.ts`,
  `src/server/projects/review-count-protocol.ts`, `src/server/review/review-membership.ts`: Acquire lightweight review
  counts through a bounded worker queue, reuse active project publications, and send count-specific browser updates.
- `src/server/projects/project-directory.ts`: Cache project display names and worktree grouping outside the listener.
- `src/server/workspace/input-watch.ts`: Follow parent-directory notifications and reconcile missed input changes.
- `src/server/views/project-cache-row.tsx`, `src/server/views/cache-quantity.tsx`: Share project-row and cache quantity
  presentation between initial pages and later inventory patches.
- `src/server/browser/cache-previews.ts`: Keep cache breakdown popovers accessible through mouse, keyboard, and native
  dismissal controls.

- `src/cli`: Composes core services into commands, prompts, terminal presentation, and executable startup.

- `src/server`: Serves documents and actions through HTTP, rendered views, browser controllers, and supervised workers.

- `src/core/configuration`: Validates shared and personal settings and applies edits while preserving comments.

- `src/core/projects`: Owns project scopes, registration, source selection, and filesystem edit plans.

- `src/core/diagnostics`: Defines structured outcomes and safe diagnostic presentation shared by interfaces and tooling.

- `src/core/runtime`: Provides bounded reads, owned publication, subprocess supervision, and platform primitives.

- `src/core/runtime/validation.ts`, `src/core/runtime/retained-bytes.ts`, `src/core/runtime/file-identity.ts`: Share
  field-specific boundary errors, budget-aware graph accounting, and filesystem identity observations.

- `src/server/views/diagram-view.tsx`: Share isolated diagram and source presentations across records and comparisons.
- `src/server/views/task-history.tsx`, `src/server/views/history-page.tsx`, `src/server/views/code-difference.tsx`:
  Present task-linked deliveries and immutable file comparisons during outcome acceptance, sharing exact-version
  document review rendering without granting acknowledgment through inspection.
