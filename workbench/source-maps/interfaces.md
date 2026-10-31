# Commands and configuration

Route commands, validate configuration, and maintain project integration.

- `src/project-registry.ts`, `src/project-admission.ts`, `src/project-registration.ts`, `src/project-requirements.ts`,
  `src/project-commands.ts`: Track personal checkout approval, declared and verified tool requirements, and explicit
  project lifecycle commands.
- `src/cli-internal.ts`: Shares command admission metadata between bootstrap, help, and execution, including inherited
  worker admission.
- `src/managed-installations.ts`: Records ownership of newly installed manager toolsets for conservative auto-pruning.
- `src/project-cache.ts`, `src/auto-prune.ts`: Bind reviewed cache cleanup to ownership and registration, and retire
  superseded owned assets after verified replacement checks.
- `src/help-pager.ts`: Page long interactive help while preserving complete noninteractive output and terminal state.
- `src/web/project-hub.ts`, `src/web/hub-lifecycle.ts`, `src/web/hub-pages.tsx`, `src/web/project-paths.ts`: Serve
  project navigation and cache maintenance through one local origin, with scoped routes, typed renderers, resource
  admission, idle view eviction, and draining shutdown.
- `src/web/cache-worker.ts`, `src/web/cache-protocol.ts`, `src/web/cache-inventory.ts`, `src/web/inventory-service.ts`:
  Validate maintenance protocols and publish component metadata before persistent size measurements.
- `scripts/cache-generation.mts`, `scripts/cache-generation.mjs`: Persist size estimates separately from writer-owned
  invalidation markers, without using estimates as deletion authority.
- `src/bounded-state.ts`: Apply the same decoding and byte limits to state reads and writes.
- `src/web/reference-client.ts`: Show accessible record-reference previews without changing link navigation.
- `src/web/hub-client.ts`: Refresh asynchronously calculated cache inventory without replacing navigation or drafts.
- `src/demonstration.ts`, `src/web/demo-service.ts`, `demo`: Assemble a disposable consuming project from packaged,
  readable demonstration data.

| Paths                                                                                                                                             | Responsibility                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/decision-record.ts`                                                                                                                          | reads decision text and metadata and normalizes owned and cross-source ADR references.                                  |
| `src/config-schema.ts`                                                                                                                            | validates shared settings, automation, and registry keys and field types.                                               |
| `src/paths.ts`                                                                                                                                    | enforces portable project paths and rejects symlink redirection.                                                        |
| `src/invariants.ts`                                                                                                                               | checks parser/collection invariants and counts human-facing text.                                                       |
| `src/secrets.ts`                                                                                                                                  | detects recognized credential formats without printing values.                                                          |
| `src/project-model.ts`, `src/project-context.ts`, `src/project-configuration.ts`, `src/record-identity.ts`, `src/record-files.ts`, `src/files.ts` | Separate project declarations, checkout resolution, validated configuration, record identity/discovery, and file reads. |
| `src/projects.ts`                                                                                                                                 | owns non-destructive setup, subproject registration, and Git hook configuration.                                        |
| `src/direnv.ts`                                                                                                                                   | composes per-root direnv hooks, preserves personal shell settings, and watches resolved configuration and tool inputs.  |
| `src/language-config.ts`                                                                                                                          | resolves shared language definitions, complete local replacements, and local additions.                                 |
| `src/languages.ts`                                                                                                                                | inspects definitions, seeds reference roots, and verifies reference projects.                                           |
| `src/java-config.ts`                                                                                                                              | reads literal Java release targets and exact Temurin build pins.                                                        |
| `src/skill-catalog.ts`                                                                                                                            | Reads and fingerprints pinned definitions and computes project applicability and update differences.                    |
| `src/choice-tree.ts`                                                                                                                              | owns pure selection, tree navigation, expansion, disabled rows, and confirmation transitions.                           |
| `src/presentation.ts`                                                                                                                             | resolves personal plain presentation and independent color suppression.                                                 |
| `src/plain-choice.ts`                                                                                                                             | presents complete numbered choices using shared selection rules and line-oriented input.                                |
| `src/terminal-choice.ts`                                                                                                                          | adapts selection to terminal input, rendering, footer confirmation, cancellation, and restoration.                      |
| `src/skill-commands.ts`                                                                                                                           | Inspects skills and updates user-wide preferences with conflict detection and explicit partial-success errors.          |
| `src/skill-ignores.ts`                                                                                                                            | Maintains checkout-owned Git exclusion blocks without replacing user rules.                                             |
| `src/skills.ts`                                                                                                                                   | Maintains ignored personal discovery links while preserving independently authored skills.                              |
| `src/input-errors.ts`                                                                                                                             | distinguishes invalid caller-owned data from unexpected implementation failures.                                        |
| `src/terminal-table.ts`                                                                                                                           | formats inspection tables with aligned quantities and optional group separators.                                        |
| `src/byte-size.ts`                                                                                                                                | formats decimal size estimates and exact byte counts used in enforced-bound diagnostics.                                |
| `src/user-config.ts`                                                                                                                              | validates global machine settings and owns configuration inspection and updates.                                        |
| `src/config-command.ts`                                                                                                                           | exposes scoped human configuration while preserving agent-managed automation.                                           |
| `src/toml-edit.ts`                                                                                                                                | Applies checked TOML updates while retaining comments and untouched formatting.                                         |
| `src/completion.ts`                                                                                                                               | derives shell completion from command definitions and global option metadata.                                           |
| `src/toolchains.ts`                                                                                                                               | reads native tool pins, resolves package-manager commands, and verifies tools inside check environments.                |
| `src/query-command.ts`                                                                                                                            | preserves literal query text after the command-line "--" separator.                                                     |
| `src/main.ts`                                                                                                                                     | owns the hierarchical command interface and routing.                                                                    |
| `src/cli-help.ts`                                                                                                                                 | groups and orders command discovery around user workflows.                                                              |
| `.githooks/pre-commit`, `.githooks/pre-push`, `.githooks/commit-msg`                                                                              | Checks staged and outgoing commit trees using the selected executable; validates change messages.                       |
| `src/review.ts`, `src/test-timing.ts`                                                                                                             | binds human acknowledgment to protected staged content; `src/test-timing.ts` reports advisory suite timing.             |
| `src/review-policy.ts`                                                                                                                            | isolates staged policies for compatibility inspection and acknowledgment independently of human record approval.        |
| `src/staged-records.ts`                                                                                                                           | Reads immutable Git trees and classifies project-owned records from staged and committed registrations.                 |
| `src/record-retention.ts`                                                                                                                         | protects canonical records in registered scopes, excluding exports and supporting files.                                |
| `src/script-language-config.ts`                                                                                                                   | reads native script-language support floors without executing project code.                                             |

- `src/terminal-text.ts`: Sanitizes terminal controls and clips text at grapheme boundaries for progress displays.

- `src/project-hierarchy.ts`: Resolves display names, registered parent scopes, and name-based breadcrumbs for the UI
  and CLI.
- `src/web/source-navigation.tsx`, `src/web/source-client.ts`: Render project and collection navigation and own
  accessible branch disclosure.
- `src/record-service.ts`: Discovers browsable project and collection records, lists owned supporting files, and saves
  human edits with content-version checks.
- `src/review-service.ts`: Inspects working and staged changes, merges independent per-file human acknowledgments, and
  retains the latest reviewed ADR contents for comparison.
- `src/web/server.ts`: Owns the loopback listener, request boundaries, browser actions, live connections, and shutdown.
- `src/web/pages.tsx`, `src/web/render-links.tsx`, `src/web/components.tsx`, `src/web/style.css`: Present records,
  review snapshots, collection proposals, safe Markdown, accessible source differences, and Catalog-inspired styling.
- `src/web/record-pages.tsx`, `src/web/review-page.tsx`, `src/web/review-model.ts`, `src/web/collection-pages.tsx`,
  `src/web/charter-pages.tsx`, `src/web/collection-summary.tsx`: Own feature rendering and exact review-version
  preparation.
- `src/web/page-document.tsx`, `src/web/page-frame.tsx`, `src/web/view-context.ts`, `src/web/styles`: Compose the typed
  document and project frame with shared presentation context and CSS.
- `src/web/markdown-view.tsx`, `src/web/record-content.tsx`, `src/web/record-links.tsx`, `src/web/diff-view.tsx`: Own
  safe Markdown, metadata and record lists, record-reference previews, and diff presentation. ESLint confines raw HTML
  to the escaped Markdown renderer.
- `src/record-lookup.ts`: Builds snapshot-owned indexes for normalized identities, absolute record paths, and owned
  supporting-file roots, preserving source boundaries and lookup precedence.
- `src/web/action-forms.tsx`, `src/web/locations.ts`, `src/web/record-page-model.ts`: Require typed mutation targets and
  versions, construct scoped route queries, and validate record view capabilities before presentation.
- `tests/fixtures/dom.mts`, `tests/web_render_lint.test.mts`, `tests/web_components.test.mts`: Own and close
  presentation DOMs, verify configured rendering/accessibility lint enforcement, and compare initial and live cache
  rows.
- `scripts/jsx-rendering-lint.mts`, `tests/types/web_forms.mts`, `tests/web_cache_view_model.test.mts`: Share static JSX
  enforcement, verify rejected form/route declarations during typechecking, and compare inventory indexes against
  independent scans.
- `src/web/navigation-state.ts`, `src/web/error-response.ts`, `src/web/workspace-codec.ts`, `src/web/size-protocol.ts`,
  `src/web/inventory-protocol.ts`: Validate route choices, preserve navigation context, and decode typed service data.
- `src/web/cache-view-model.ts`, `src/web/cache-quantity.ts`, `src/web/cache-measurements.ts`: Prepare cache ownership
  rows, share quantity states, and bound concurrent directory measurements.
- `src/web/focus.ts`: Restores keyboard focus to the same record or navigation context after live publication.
- `src/web/client.ts`, `src/web/assets.ts`: Enhance server-rendered pages with live updates, protected drafts, and
  browser actions; the asset module is generated from browser TypeScript and authored CSS by the tooling build.
- `src/web/live.ts`: Reconciles filesystem changes and Git state, watches relevant directories, and reports revisions.
- `src/web/diff.ts`: Produces source differences from exact staged or working-file contents.
- `src/web/comparison-result.ts`: Keeps each acquired comparison independent from document availability and other
  baselines.
- `src/web/workspace-problem.ts`: Shares safe workspace freshness messages with browser controllers.
- `src/web/review-navigation.ts`: Preserves queue order, source selection, and layout between individual reviews.
- `src/web/breadcrumbs.tsx`: Links declared project names and page ancestors without repeating the current heading.
- `src/web/paragraph-diff.ts`, `tests/web_diff.test.mts`: Use Markdown block boundaries and pinned jsdiff matching to
  compare logical paragraphs and highlight word edits while preserving meaningful literal-source whitespace.
- `src/web/collection-service.ts`, `src/web/collection-runner.ts`: Share verified collection preview/application with
  CLI reconciliation and keep acquisition outside the HTTP listener.
- `docs/web.md`: Documents local browser access, record views, live refresh, editing, review, and collection workflows.
- `tests/web_reviews.test.mts`, `tests/web_server.test.mts`, `tests/web_collections.test.mts`, `tests/fixtures/web.mts`:
  Verify independent approvals, stale edits, browser boundaries, live updates, owned files, and exact collection plans.
- `scripts/check-web-browser.mts`: Exercise the shipped UI in the managed Headless Shell using disposable projects,
  retaining screenshots and failure diagnostics; explicit browser overrides aid debugging.

- `src/record-metadata.ts`: Derives readable citation summaries and metadata labels without weakening record validation.
- `src/web/sources.ts`, `src/web/record-listing.ts`: Separate selected record sources and provide stable incremental
  list ordering and cursors.
- `src/web/collection-comparison.ts`: Compares adopted ADRs with verified pinned originals, including committed
  adaptations and removals, without implicit acquisition.
- `tests/web_presentation.test.mts`: Verifies source isolation, upstream comparisons, readable metadata, citation
  details, stable batches, and stale-list detection.

- `src/workspace-service.ts`, `src/web/workspace-worker.ts`: Acquire complete workspace snapshots off the listener and
  index records, reviews, collection comparisons, and document contents for interface queries.
- `src/web/browser-session.ts`, `src/web/live-client.ts`, `src/web/list-client.ts`, `src/web/form-client.ts`: Coordinate
  live publication, protected drafts, bounded incremental windows, forms, browser navigation, and resource cleanup.
- `src/web/http.ts`, `src/web/errors.ts`, `src/web/actions.ts`, `src/web/downloads.ts`: Own HTTP boundaries, explicit
  error meanings, admitted mutations, expiring proposals, and streamed descriptor lifetimes.
- `src/web/record-window.ts`: Defines shared query and browser window bounds.
- `src/web/protocol.ts`: Decode collection worker requests and verified preview shapes before use.
- `src/diagnostics.ts`, `scripts/diagnostics.mts`, `scripts/diagnostics.mjs`: Preserve bounded cause graphs, render
  versioned diagnostic events, redact credentials, and capture output with explicit omissions.
- `scripts/diagnostic-contract.mts`, `scripts/diagnostic-contract.mjs`: Define shared typed diagnostic operations,
  outcomes, severities, formats, and states without runtime-specific dependencies.
- `src/diagnostic-session.ts`: Own optional persistent diagnostic sessions and report sink failures and omissions.
- `scripts/diagnostic-text.mts`, `scripts/diagnostic-text.mjs`: Share credential grammar, UTF-8 limits, streaming
  redaction, bounded capture, and retained-stream draining.
- `scripts/diagnostic-errors.mts`, `scripts/diagnostic-errors.mjs`: Normalize, render, and decode bounded error graphs
  with process termination evidence and combined cleanup failures.
- `scripts/diagnostic-writer.mts`, `scripts/diagnostic-writer.mjs`: Bound observational writes and report dropped events
  and sink errors consistently.
- `scripts/diagnostic-records.mts`, `scripts/diagnostic-records.mjs`: Sanitize canonical JSONL as bounded records so
  quoted diagnostic text remains independently parseable during retention and reading.
- `src/diagnostic-options.ts`: Resolve flags, environment controls, and saved diagnostic preferences without mutation.
- `src/web/routes.ts`, `src/web/workspace-protocol.ts`: Own typed HTTP routes, action effects, and workspace messages.
- `tests/diagnostic_contracts.test.mts`: Verify shared vocabulary, pure option precedence, normalized rendering,
  redaction boundaries, sink accounting, and child severity preservation.
- `src/web/observability.ts`: Correlate requests, report stream failures, and collect fixed-cardinality service metrics.
- `tests/diagnostics.test.mts`, `tests/diagnostic_cli.test.mts`, `tests/web_observability.test.mts`: Verify diagnostic
  contracts, transport, redaction, bounded capture, HTTP correlation, mutation outcomes, and capacity observations.
- `src/web/citation-documents.ts`: Serve bounded, digest-verified PDF views and downloads from the owned citation
  library, using the citation service's source-specific local presence.
- `tests/web_citations.test.mts`, `scripts/web-browser-fixtures.mts`: Verify citation availability, streamed byte
  ranges, document integrity, and native PDF viewing with an offline document fixture.
- `scripts/web-browser-scenarios.mts`: Define named shipped-browser workflows.
- `tests/web_client.test.mts`, `tests/web_protocol.test.mts`: Verify asynchronous draft protection, focus-preserving
  window bounds, and cleanup.

- `src/initialization.ts`, `src/project-edits.ts`: Plan and apply new-project or existing-project adoption, reject
  conflicts before publishing files, and preserve consumer-owned automation and integrations.
- `src/markdown-links.ts`: Relocates embedded Markdown links while retaining authored content and code examples.
- `tests/initialization.test.mts`, `tests/markdown_links.test.mts`, `tests/web_onboarding.test.mts`: Verify all language
  starters, preservation and preflight behavior, link targets, human charter creation, and cross-source review
  reminders.

- `src/file-reads.ts`, `scripts/file-publication.mts`, `scripts/file-publication.mjs`: Read regular files through
  bounded descriptors and publish complete staged bytes with per-file preconditions and explicit cleanup failures.
- `src/git-snapshot.ts`: Capture HEAD and the staged tree once and batch bounded immutable blob acquisition for review
  and workspace previews.
- `src/cache-commands.ts`, `src/cache-plan-identity.ts`: Keep terminal interaction separate from cache services and bind
  cleanup approval to ownership, writer generations, and protections independently of size measurements.
- `tests/refactor_boundaries.test.mts`, `tests/git_snapshot.test.mts`, `tests/record_allocation_lock.test.mts`,
  `tests/cache_cancellation.test.mts`, `tests/workspace_supervision.test.mts`, `tests/types/record_metadata.mts`: Verify
  publication, bounded acquisition, snapshot consistency, lock recovery, subprocess draining, read-worker supervision,
  and kind-specific record contracts.

- `src/policy-state.ts`: Decode bounded local-policy provenance and project/local reconciliation receipts before use.

- `src/configuration-snapshot.ts`: Own immutable configuration acquisition for one operation, with fresh boundaries for
  later and proposed-tree operations.
- `src/project-identity.ts`: Separate portable scope identifiers from registered directory paths and display names.
- `scripts/web-accessibility.mts`: Collect automated browser accessibility evidence and retain unverified assessment
  boundaries.

- `src/terminal-output.ts`: Sanitize terminal output independently of display-width libraries, preserving the Node 18
  bootstrap boundary.

- `src/tool-profile-output.ts`: Render tool-profile listings without coupling verified bootstrap acquisition to terminal
  rendering.
