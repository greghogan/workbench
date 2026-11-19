# Browser interface and workflows

The browser presents the same task, document, and collection authority used by the CLI. Core services own transitions
and exact versions; routes, workspace publications, views, and browser controllers deliver those decisions together. The
shipped-browser workflows exercise the assembled interface separately from domain and rendering tests.

- `src/server/views/record-pane.tsx`: Shares adjacent-record navigation and document-pane controls across reading and
  review.
- `src/server/views/task-pages.tsx`, `src/server/views/workflow-pages.tsx`, `src/server/views/review-list.tsx`,
  `src/server/views/workflow-navigation.ts`, `src/server/browser/task-tree-client.ts`: Present nested records, separate
  Plans/Work/Reviews, project and task groups with bounded continuation, human decisions, and local execution order.
- `src/core/tasks/task-workflow.ts`, `src/server/workspace/task-state.ts`, `src/server/review/task-review-groups.ts`,
  `src/server/projects/task-review-inventory.ts`: Share task phase membership and approval/evidence acquisition between
  open workspaces and independently refreshed project counts.
- `src/server/views/task-history.tsx`, `src/server/views/history-page.tsx`, `src/server/views/code-difference.tsx`:
  Present task-linked deliveries and immutable file comparisons during outcome acceptance, sharing exact-version
  document review rendering without granting acknowledgment through inspection.
- `src/server/projects/project-hub.ts`, `src/server/projects/hub-lifecycle.ts`, `src/server/views/hub-pages.tsx`,
  `src/server/routes/project-paths.ts`, `src/server/projects/project-mounts.ts`: Serve project navigation and cache
  maintenance through one local origin, with scoped routes, typed renderers, resource admission, idle view eviction, and
  draining shutdown.
- `src/server/http/browser-auth.ts`: Check process-lifetime credentials for the private browser listener and its
  demonstration connection.
- `src/server/cache/cache-worker.ts`, `src/server/cache/cache-protocol.ts`, `src/server/cache/cache-inventory.ts`,
  `src/server/cache/inventory-service.ts`: Validate maintenance protocols and publish component metadata before
  persistent size measurements.
- `src/server/browser/reference-client.ts`: Show accessible record-reference previews without changing link navigation.
- `src/server/views/diagram-view.tsx`, `src/server/browser/diagram-client.ts`, `src/server/browser/diagram-renderer.ts`,
  `src/server/http/diagram-asset.ts`, `resources/browser`: Render local Mermaid diagrams in an isolated frame, display
  inert images, and preserve readable source during failure and review.
- `src/server/browser/card-client.ts`: Add card navigation while preserving ordinary links, text selection, and
  controls.
- `src/server/browser/hub-client.ts`: Refresh asynchronously calculated cache inventory without replacing navigation or
  drafts.
- `src/server/demo/demonstration.ts`, `src/server/demo/demonstration-story.ts`, `src/server/projects/demo-service.ts`:
  Assemble a disposable consuming project from packaged, readable demonstration data.
- `src/server/views/source-navigation.tsx`, `src/server/browser/source-client.ts`: Render project and collection
  navigation and own accessible branch disclosure.
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
- `src/server/presentation/date-time.ts`, `src/server/browser/date-time-client.ts`: Render minute-precision times with
  an explicit zone, enhancing them with the browser locale while preserving wire timestamps.
- `src/server/browser/focus.ts`: Restores keyboard focus to the same record or navigation context after live
  publication.
- `src/server/browser/client.ts`, `src/server/browser/assets.ts`, `src/server/browser/asset-manifest.ts`: Enhance
  server-rendered pages with live updates, protected drafts, and browser actions; the asset module is generated from
  browser TypeScript and authored CSS by the tooling build.
- `src/server/workspace/live.ts`: Reconciles filesystem changes and Git state, watches relevant directories, and reports
  revisions.
- `src/server/workspace/workflow-updates.ts`, `src/server/browser/workflow-notifications.ts`: Limit live refresh to
  visible workflow changes and notify the developer about new decisions.
- `src/server/review/diff.ts`: Compare current record contents with acquired review and collection baselines.
- `src/server/review/comparison-result.ts`: Keeps each acquired comparison independent from document availability and
  other baselines.
- `src/server/workspace/workspace-problem.ts`: Shares safe workspace freshness messages with browser controllers.
- `src/server/review/review-layout.ts`, `src/server/review/review-navigation.ts`: Share the review queue order with the
  document arrows while retaining independent file reviews.
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
- `test/integration/browser/runner.mts`, `test/integration/browser/service-output.mts`: Start the private service for
  Chromium workflows, scope browser sign-in to its origin, and retain redacted diagnostics on failure.
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
- `src/server/browser/browser-session.ts`, `src/server/browser/live-client.ts`, `src/server/browser/list-client.ts`,
  `src/server/browser/form-client.ts`: Coordinate live publication, protected drafts, per-file review refresh, bounded
  incremental windows, forms, navigation, and cleanup.
- `src/server/http/http.ts`, `src/server/http/errors.ts`, `src/server/projects/actions.ts`,
  `src/server/http/downloads.ts`: Own HTTP boundaries, explicit error meanings, admitted mutations, expiring proposals,
  and streamed descriptor lifetimes.
- `src/server/routes/record-window.ts`: Defines shared query and browser window bounds.
- `src/server/projects/protocol.ts`: Decode collection worker requests and verified preview shapes before use.
- `src/server/routes/routes.ts`, `src/server/workspace/workspace-protocol.ts`: Own typed HTTP resource paths, query
  contracts, action effects, and workspace messages.
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
- `test/cli/initialization.test.mts`, `test/core/records/markdown_links.test.mts`,
  `test/server/projects/web_onboarding.test.mts`: Verify all language starters, preservation and preflight behavior,
  link targets, human charter creation, and cross-source review reminders.
- `test/core/git/git_snapshot.test.mts`, `test/core/records/record_allocation_lock.test.mts`,
  `test/core/storage/cache_cancellation.test.mts`, `test/server/workspace/workspace_supervision.test.mts`,
  `test/core/records/record_metadata.mts`: Verify publication, bounded acquisition, snapshot consistency, lock recovery,
  subprocess draining, read-worker supervision, and kind-specific record contracts.
- `test/integration/browser/web-accessibility.mts`: Collect automated browser accessibility evidence and retain
  unverified assessment boundaries.
- `src/server/workspace/worker-generation.ts`: Pin worker code for each listener lifetime and release it after draining.
- `src/core/review/review-snapshot.ts`, `src/server/review/review-status.ts`: Validate presented bytes and lightweight
  version-status replies.
- `src/server/review/document-comparison-model.ts`: Prepare immutable comparison decisions separately from rendered
  markup.
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
- `src/server`: Serves documents and actions through HTTP, rendered views, browser controllers, and supervised workers.

- `src/server/views/commit-files.tsx`, `src/server/views/commit-file-diff.tsx`,
  `src/server/views/commit-file-actions.tsx`, `src/server/views/commit-navigation.tsx`,
  `src/server/views/diff-icons.tsx`, `src/server/views/history-comparison.tsx`,
  `src/server/views/code-highlighting.tsx`, `src/server/review/file-comparison.ts`: Present immutable source diffs with
  numbered, expandable context and escaped syntax; retain complete formatted documents for record acknowledgment.
- `src/server/browser/commit-files-client.ts`, `src/server/browser/file-diff-client.ts`: Filter the complete
  changed-file tree and load immutable comparisons near the viewport; preserve keyboard focus, supplied links, and
  request cleanup.
