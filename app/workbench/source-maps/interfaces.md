# CLI and shared presentation

Commands adapt the shared core to terminal workflows; configuration and diagnostics retain their common ownership.

- `src/cli/rust-cache-command.ts`: Preview fresh owned Rust artifact selections and revalidate reviewed cleanup.
- `src/cli/tasks.ts`, `src/core/tasks/task-model.ts`, `src/core/tasks/task-service.ts`, `src/core/tasks/task-queue.ts`:
  Resolve task graphs, shared decisions, and atomic local queue progress across the CLI and web UI.
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
- `src/core/storage/cache-generation.mts`: Persist size estimates separately from writer-owned invalidation markers,
  without using estimates as deletion authority.
- `src/core/storage/bounded-state.ts`: Apply the same decoding and byte limits to state reads and writes, with bounded
  retries for transient replacement during a read.
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
- `src/core/records/record-service.ts`: Discovers browsable project and collection records, lists owned supporting
  files, and saves human edits with content-version checks.
- `src/core/review/review-service.ts`: Inspects working and staged changes, merges independent per-file human
  acknowledgments, and retains the latest reviewed record contents for comparison without making current-file approval
  depend on staged declarations.
- `src/core/records/record-lookup.ts`: Builds snapshot-owned indexes for normalized identities, absolute record paths,
  and owned supporting-file roots, preserving source boundaries and lookup precedence.
- `src/core/storage/browser-evidence.ts`: Owns binary artifact manifests and producer lifetimes separately from fixture
  scratch and text logs. Plans and revalidates retention using each project's policy, recovers proven abandoned runs,
  and preserves uncertain evidence.
- `src/core/records/record-metadata.ts`: Derives readable citation summaries and metadata labels without weakening
  record validation.
- `src/core/execution/ci/support/ci-browser-timings.mts`: Summarize retained browser timing evidence without historical
  comparisons or timing gates.
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
- `test/core/diagnostics/diagnostic_contracts.test.mts`: Verify shared vocabulary, pure option precedence, normalized
  rendering, redaction boundaries, sink accounting, and child severity preservation.
- `src/cli/initialization.ts`, `src/core/projects/project-edits.ts`: Plan and apply new-project or existing-project
  adoption, reject conflicts before publishing files, and preserve consumer-owned automation and integrations.
- `src/core/records/markdown-links.ts`: Encodes generated destinations, extracts actual links, and relocates embedded
  links while preserving authored text and literal examples.
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
- `src/core/collections/policy-state.ts`: Decode bounded local-policy provenance and project/local reconciliation
  receipts before use.
- `src/core/configuration/configuration-snapshot.ts`: Own immutable configuration acquisition for one operation, with
  fresh boundaries for later and proposed-tree operations.
- `src/core/projects/project-identity.ts`: Separate portable scope identifiers from registered directory paths and
  display names.
- `src/core/diagnostics/terminal-output.ts`: Sanitize terminal output independently of display-width libraries,
  preserving the Node 18 bootstrap boundary.
- `src/cli/tool-profile-output.ts`: Render tool-profile listings without coupling verified bootstrap acquisition to
  terminal rendering.
- `src/core/records/markdown-excerpt.ts`: Extract readable prose for shared record previews.
- `src/cli/development-selection.ts`, `src/cli/server.ts`, `src/cli/project-setup.ts`,
  `src/cli/collection-confirmation.ts`, `src/cli/terminal/project-prompt.ts`: Compose commands, server lifecycle,
  interactive project setup, and collection acceptance around shared services.
- `src/cli`: Composes core services into commands, prompts, terminal presentation, and executable startup.
- `src/core/configuration`: Validates shared and personal settings and applies edits while preserving comments.
- `src/core/projects`: Owns project scopes, registration, source selection, and filesystem edit plans.
- `src/core/diagnostics`: Defines structured outcomes and safe diagnostic presentation shared by interfaces and tooling.
- `src/core/runtime`: Provides bounded reads, owned publication, subprocess supervision, and platform primitives.
- `src/core/runtime/validation.ts`, `src/core/runtime/retained-bytes.ts`, `src/core/runtime/file-identity.ts`: Share
  field-specific boundary errors, budget-aware graph accounting, and filesystem identity observations.
