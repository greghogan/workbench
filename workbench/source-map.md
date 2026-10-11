# Source map

Start at `AGENTS.md` for project context, `workbench/decision-map.md` for decisions, and `workbench/task-map.md` for
unfinished work. The first decision set remains draft pending human review.

The authorized initial draft ADR reorder is recorded in `workbench/evidence/adr-order-20261009.json`; its mapping
preserves the previous references for review while current documents use the reordered IDs.

- `src/collections.ts` verifies installed collection inventories, resolves shared pins and automatic local registries,
  and installs immutable revisions from explicitly acquired local sources.
- `src/collection-schema.ts` validates collection identities, pins, manifests, and machine-local lookup directories.
- `src/collection-install.ts` preflights proposed policy selections and atomically selects related installations.
- `src/collection-commands.ts` exposes collection inspection, installation, selected ADR exports, policy comparisons,
  and audience checks.
- `src/collection-links.ts` resolves portable shared source links without importing machine-local context.
- `src/collection-maps.ts` renders exported decision maps from verified record metadata.
- `src/decision-record.ts` reads decision text and metadata and normalizes owned and cross-source ADR references.
- `src/collection-provision.ts` freezes verified local collection files and selections into disposable CI workspaces.
- `src/record-resolver.ts` resolves integrated ADR references while keeping other records project-owned.
- `bin/workbench.mjs` starts the checked-in Node bundle and identifies the owning project.
- `bin/workbench` and `bin/workbench.cmd` provide POSIX and Windows launchers.
- `bin/bundle-runtime.cjs` decompresses and executes artifacts in memory using Node's CommonJS module context.
- `src/config-schema.ts` validates shared settings, automation, and registry keys and field types.
- `src/paths.ts` enforces portable project paths and rejects symlink redirection.
- `src/invariants.ts` checks parser/collection invariants and counts human-facing text.
- `src/advisories.ts` checks locked dependencies and resolved vcpkg sources against OSV.
- `src/secrets.ts` detects recognized credential formats without printing values.
- `src/core.ts` owns project configuration, record identities, canonical paths, and safe file operations.
- `src/projects.ts` owns non-destructive setup, subproject registration, and Git hook configuration.
- `src/distribution-manifest.ts` seals prepared runnable distributions and verifies portable content identities.
- `src/installation-store.ts` owns immutable versions, owner namespaces, retention roots, and conservative pruning.
- `src/installation-project.ts` registers private checkout profiles and materializes exact dependencies in snapshots.
- `src/installation-dispatch.ts` selects the pinned executable and protects active commands.
- `src/installation-commands.ts` exposes verified installation, profile inspection, generations, and maintenance.
- `src/update-shared.ts` prepares shared-version updates with retained generations and rollback evidence.
- `src/update-git.ts` owns isolated Git preparation and restricts migration patches to managed records and context.
- `src/update.ts` prepares and applies validated Git submodule updates with rollback and recovery evidence.
- `src/update-prepare.ts` validates records and context in the updater’s isolated checkout; `src/sync.ts` coordinates
  derived files.
- `src/language-config.ts` resolves shared language definitions, complete local replacements, and local additions.
- `languages` owns reusable per-language metadata, automation, and native artifact filters.
- `collections` owns shipped provider exports and the distribution's explicit collection dependency pins.
- `src/languages.ts` inspects definitions, seeds reference roots, and verifies reference projects.
- `src/java-config.ts` reads literal Java release targets and exact Temurin build pins.
- `examples/languages/java/scripts/check.mjs` delegates frozen Java checks and packaging to Maven.
- `scripts/java-coverage.mjs` normalizes JaCoCo line, branch, and method coverage.
- `examples/frameworks/react` is a standalone React application using the TypeScript suite and Linux x64 CI.
- `src/records.ts` creates, opens, lists, searches, and validates records and task or experiment relationships.
- `src/record-sequences.ts` reserves record identities and retains allocation history.
- `src/decisions.ts` reads canonical decision metadata and validates scoped overrides.
- `src/citations.ts` owns CSL YAML validation, identifier imports, and source-specific PDF acquisition.
- `src/releases.ts` creates release records and derives artifact indexes.
- `src/maps.ts` derives maps for all six record types and routes root maps to subprojects.
- `src/agents.ts` derives shared root context and dynamic local context from charters and applicable decision records.
- `src/skills.ts` validates skill metadata and invocation policy and maintains scoped root discovery for Codex and
  Claude.
- `src/ci.ts` derives CI coverage and installation versions from configured language roots and native pins.
- `src/ci-inputs.ts` reads cached revision inputs, applies the shared parsers, and classifies expected comparison
  failures.
- `src/input-errors.ts` distinguishes invalid caller-owned data from unexpected implementation failures.
- `src/ci-options.ts` shares comparison options and scheduler argument forwarding.
- `scripts/ci-plan-contract.mjs` and `scripts/ci-plan-contract.d.mts` validate and type hosted matrix output and define
  intentional job skips.
- `scripts/source-checkout.mjs` supplies clean source copies to coverage and CLI integration fixtures.
- `src/ci-selection.ts` counts input matches once and selects roots with structured causes from both revisions'
  dependencies.
- `scripts/ci-plan.mjs` supplies hosted event comparisons and selection summaries.
- `scripts/ci-status.mjs` requires validation and every selected hosted job to succeed.
- `src/ci-targets.ts` catalogs configured targets and groups shared hosted setup without dropping roots.
- `src/ci-runtime.ts` selects verified compatibility runtimes independently of development pins.
- `src/local-ci.ts` selects Linux x64 targets and coordinates isolated jobs and combined rehearsal reports.
- `src/local-ci-workers.ts` bounds concurrent worker admission and drains active jobs before interruption.
- `src/ci-lifecycle.ts` owns interruption across preparation, admitted commands, and cleanup.
- `src/execution-resources.ts` resolves configured CPU budgets and local CI concurrency.
- `src/cache-lock.ts` serializes shared installation writers and preserves uncertain locks.
- `scripts/cache-ownership.mjs` restores shared cache ownership without following links or failing on removed entries.
- `scripts/cpu-budget.mjs` and `scripts/cpu-budget.d.mts` supply language worker controls from one job allocation.
- `scripts/ci-linux/job.mjs` runs one target with its isolated workspace, logs, and result contract.
- `scripts/ci-worker-request.mjs` and `scripts/ci-worker-request.d.mts` validate and type private worker requests.
- `src/ci-workspace.ts` owns snapshot isolation, workspace locking, disposable resources, and cleanup recovery.
- `src/terminal-table.ts` formats check, target, and configuration inspection tables.
- `src/compilers.ts` validates C/C++ standards, compiler families, support minima, and compiler selections.
- `src/environments.ts` owns environment names, local execution preferences, and active-shell boundaries.
- `src/builds.ts` resolves local or external build storage, native tool controls, locking, and scoped cleanup.
- `src/user-config.ts` validates global machine settings and owns configuration inspection and updates.
- `src/config-command.ts` exposes scoped human configuration while preserving agent-managed automation.
- `src/dependencies.ts` switches dependency installations and maintains Python environment links.
- `.pnpmfile.cjs` applies Workbench storage to direct pnpm commands; TypeScript and React include project-owned copies.
- `src/completion.ts` derives shell completion from command definitions and global option metadata.
- `src/shell.ts` opens the selected development shell or runs a command in it.
- `src/checks.ts` runs portable configured check roles and selected native, Guix, Nix, or Dev Container environments.
- `src/check-plan.ts` selects stages, scoped roots, setup sessions, and coverage variants.
- `src/toolchains.ts` reads native tool pins, resolves package-manager commands, and verifies tools inside check
  environments.
- `src/tool-probes.ts` declares package executables and shares version probes between installation and environment
  guards.
- `src/formatting.ts` bundles canonical Markdown/YAML formatting and scopes batch operations to registered records.
- `src/record-document.ts` owns prose-record frontmatter, metadata schemas, and serialization.
- `src/documentation.ts` and `src/validation.ts` own documentation and structural checks.
- `src/feedback.ts` stores local feedback in the platform data directory; `src/commit.ts` validates change-message
  policy.
- `src/record-commands.ts` defines record browsing and actions, shared query options, and current-scope ID resolution.
- `src/query-command.ts` preserves literal query text after the command-line "--" separator.
- `src/main.ts` owns the hierarchical command interface and routing.
- `tests` exercises both project layouts, every record type, contextual help, skill activation, and safe cleanup.
- `skills` contains shared review, refactor, audit, defect-investigation, experiment, adoption, and CI workflows plus CI
  version updates (including Debian bases), environment updates, and language-specific dependency updates.
- `bundle` contains distributable JavaScript.
- `scripts/build-bundle.mjs` builds the bundle; `scripts/check-bundle.mjs` checks it against TypeScript sources.
- `scripts/bundle-licenses.mjs` retains the license notices of bundled dependencies.
- `scripts/bundle-license-overrides.json` identifies digest-pinned upstream licenses missing from published packages;
  `scripts/licenses` retains those license texts.
- `scripts/bundle-options.mjs` shares build settings for compact runnable artifacts and temporary coverage builds.
- `scripts/bundle-artifacts.mjs` selects compression and generates deterministic payloads and their launchers.
- `scripts/check-shell` provides shell format and lint roles used by local checks and the Git adapter.
- `scripts/check-harnesses.mjs` verifies real Codex and Claude instruction and skill loading against a local model stub
  in disposable repositories and application homes.
- `scripts/evaluate-skills.mjs` runs opt-in model evaluations with isolated application state and retained review
  evidence.
- `scripts/skill-evaluation-cases.mjs` owns fixtures and behavioral grading.
- `.github/workflows/checks.yml` runs configured native OS, compatibility-runtime, and Linux Guix/Nix/Dev Container
  jobs.
- `.github/actionlint.yaml` lists verified hosted-runner labels absent from the pinned validator's built-in list.
- `.node-version` and `.tool-versions` pin native host tools.
- `.githooks/pre-commit` checks staged files and verifies the pinned Workbench checkout; `.githooks/commit-msg`
  validates change messages.
- `.gitattributes` excludes generated bundle string literals from Git whitespace checks; bundle parity checks their
  source.
- `examples/languages` contains executable TypeScript, JavaScript, Java, Rust, Python, C, C++, and Go references with
  optional Guix and Nix environments.
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` lock TypeScript dependencies and scripts.
- `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mjs`, and `.prettierrc.json` set code-quality defaults.
- `channels.scm` pins Guix for `manifest.scm`, which lists optional development tools; `.envrc` only loads local
  settings and the launcher path.
- `Makefile` exposes development commands, delegates checks to Workbench, and cleans local outputs and dependencies.
- `src/review.ts` binds human acknowledgment to protected staged content; `src/test-timing.ts` reports advisory suite
  timing.
- `src/doc-examples.ts` verifies executable console examples.
- `examples/languages/c/scripts/check.mjs`, `examples/languages/go/scripts/check.mjs`, `scripts/check-python.mjs`, and
  `scripts/check-rust.mjs` adapt build, coverage, and timing tools. Native checks also verify optimized static-library
  linkage, unsupported LTO combinations, and release behavior before preparing artifacts;
  `tests/native_release.test.mjs` covers failure safety.
- `src/native-tools.ts` installs and selects declared native tools in platform cache storage; `src/storage.ts` resolves
  platform user directories and keeps durable records separate.
- `src/native-assets.ts` resolves native pins, authenticated artifact metadata, filters, and installation identities.
- `src/native-asset-maintenance.ts` plans acquisition metadata pruning from active pins and atomically publishes
  validated, optionally formatted replacements.
- `src/package-manager.ts` delegates locked package-manager bootstrap to npm in isolated platform cache storage.
- `scripts/package-manager` retains the shared npm bootstrap manifest and lockfile for pnpm and its platform packages.
- `src/miri.ts` validates supplementary dated Rust nightly pins and invokes Miri without changing compiler defaults.
- `src/tool-downloads.ts` verifies upstream artifacts and safely publishes installations; `scripts/native-assets.json`,
  `scripts/llvm-assets.json`, and `scripts/bootstrap-tools.json` record verified acquisition metadata.
- `src/archive-extraction.ts` bounds ordinary tar and ZIP extraction; `src/artifact-decoders.ts` owns bounded,
  cancellable decompression.
- `src/artifact-streams.ts` bounds and hashes incoming bytes and checks archive metadata before buffering.
- `src/artifact-signatures.ts` verifies streamed OpenPGP signatures against declared signers in private keyrings.
- `src/artifact-policy.ts` binds installation provenance and cache identities to source, filter, proofs, and trust.
- `src/artifact-repositories.ts` authenticates signed repository catalogs, pinned indices, and exact runtime packages.
- `scripts/keys/README.md` records pinned public trust material and proof availability.
- `scripts/ci-linux/bootstrap.py` authenticates and privately stages the initial Node runtime before activation.
- `src/artifact-attestations.ts` verifies artifact provenance against declared identities and retained trust roots.
- `src/filtered-artifacts.ts` contains the draft filtered extraction, retained-content manifests, and cache
  verification.
- `scripts/keys` retains the artifact verification keys and Sigstore trust roots used by the draft installer.
- `scripts/ci-run.mjs` executes shared native, compatibility, managed-environment, and standalone release phases.
- `scripts/ci-contract.mjs` defines target phases and execution selections; `scripts/ci-contract.d.mts` defines the
  target variants and phase types.
- `scripts/ci-layout.mjs` defines cache locations and forwarded CI variables; `scripts/ci-layout.d.mts` declares its
  interface.
- `scripts/ci-results.mjs` validates and persists combined target/infrastructure outcomes and collects attempt evidence;
  `scripts/ci-results.d.mts` declares the result protocol.
- `scripts/ci-reports.mjs` collects only reports produced by the current target; `scripts/ci-reports.d.mts` declares its
  shared TypeScript interface.
- `scripts/ci-linux` contains the authenticated Ubuntu bootstrap image and local target/report coordinator.
- `src/vcpkg.ts` prepares pinned C/C++ dependencies with the selected compiler and ABI-aware caching.
- `src/devcontainers.ts` adapts the locked Dev Container CLI with private startup scratch directories and cleanup;
  `.devcontainer` defines the workspace and its OS prerequisites.
- `scripts/ci-cache.mjs` reuses selected verified tools, dependency downloads, compiled GCC, and Guix source history.
- `workbench/quality.json` declares coverage floors for Workbench TypeScript, including CLI subprocess execution.
- `scripts/test-coverage.mjs`: combine Vitest and copied CLI coverage using the same AST converter and enforce unchanged
  floors.
- `scripts/coverage-summary.mjs` normalizes coverage baselines and presents changes in terminal and CI summaries.
- `scripts/check-coverage-summary.mjs` translates language-native reports into comparable summaries.
- `scripts/clean.mjs` removes configured local artifacts without following links into shared caches.
- `workbench/evidence` retains small reproduction recipes for recorded experiments; generated installations and full
  reports stay in disposable storage.
- `scripts/release-rust.mjs` copies Cargo-reported executables from the build cache into the release directory.
- `scripts/package-workbench.mjs` prepares a local runnable distribution without local settings or generated caches.
- `scripts/package-output.mjs` stages distribution output and replaces only owned packages after validation.
- `scripts/check-release.mjs` verifies the prepared Workbench CLI distribution outside the checkout. Example-owned
  release verification scripts check their own packages and binaries.

- `src/profile-schema.ts` validates named development and release profile declarations.
- `src/development.ts` lists profiles and persists local development selection.
- `src/release-profiles.ts` prepares configured artifacts, verifies relocated copies, and records provenance.
- `src/task-checklists.ts` synchronizes linked child statuses and validates task completion checklists.
- `workbench/guides/execution.md` documents CPU allocation, language controls, CI isolation, and cache ownership.
- `workbench/guides/profiles.md` documents profile selection, packaging recipes, and completion installation.

## Ruby support

- `src/ruby-manager.ts` bootstraps the verified, lockfile-selected Bundler through RubyGems.
- `src/runtime-builds.ts` builds verified language runtimes in private installation images.
- `src/script-language-config.ts` reads native script-language support floors without executing project code.
- `src/seven-zip.ts` validates bounded RubyInstaller archive members and contained extraction.
- `examples/languages/ruby/scripts/check.mjs` delegates Ruby quality and packaging roles to locked tools.
- `scripts/ruby-coverage.mjs` normalizes SimpleCov production line and branch coverage.

## PHP support

- `src/php-manager.ts` verifies the pinned Composer bootstrap before delegating package operations.
- `src/php-coverage.ts` installs verified Xdebug sources for the selected PHP ABI.
- `examples/languages/php/scripts/check.mjs` adapts Composer, analysis, tests and packaging to Workbench roles.
- `scripts/php-coverage.php` translates PHPUnit production coverage into compact summaries.
- `examples/languages/php/.composer/verify/src/VerifyPlugin.php` checks Composer distribution SHA-256 before extraction.

- `scripts/ci-native-prerequisites.mjs` prepares hosted SDK dependencies for native Ruby and PHP runtimes.

- `src/compatibility-checks.ts` selects and describes project-owned compatibility commands from the selected language
  definition.

- `scripts/ci-cache-metrics.mjs` records cache footprint and elapsed verification-window evidence.
- `scripts/ci-publish.mjs` verifies prepared image receipts, publishes selected CI tags, and checks registry pulls.
- `.github/workflows/publication.yml` separately selects Nix/Guix registry verification with package write authority.

- `.github/workflows/windows-diagnostics.yml` temporarily verifies the native Windows job before the full matrix rerun.
