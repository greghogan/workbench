# Source map

Start at `AGENTS.md` for project context, `workbench/decision-map.md` for decisions, and `workbench/task-map.md` for
unfinished work. The first decision set remains uncommitted pending human review.

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
- `src/update.ts` prepares and applies validated Git submodule updates with rollback and recovery evidence.
- `src/update-prepare.ts` validates records and context in the updater’s isolated checkout; `src/sync.ts` coordinates
  derived files.
- `src/languages.ts` loads language references, seeds TypeScript roots, and verifies reference projects.
- `src/records.ts` creates, opens, lists, searches, and validates records and task or experiment relationships.
- `src/record-sequences.ts` reserves record identities and retains allocation history.
- `src/decisions.ts` reads canonical decision metadata and validates scoped overrides.
- `src/citations.ts` owns CSL YAML validation, identifier imports, and source-specific PDF acquisition.
- `src/releases.ts` creates release records and derives artifact indexes.
- `src/maps.ts` derives maps for all six record types and routes root maps to subprojects.
- `src/agents.ts` derives the entire root agent context from human-written project charters and scoped decision records.
- `src/skills.ts` validates skill metadata and invocation policy and maintains scoped root discovery for Codex and
  Claude.
- `src/ci.ts` derives CI coverage and installation versions from configured language roots and native pins.
- `src/compilers.ts` validates C/C++ standards, compiler families, support minima, and compiler selections.
- `src/environments.ts` owns environment names, local execution preferences, and active-shell boundaries.
- `src/builds.ts` resolves local or external build storage, native tool controls, locking, and scoped cleanup.
- `src/user-config.ts` validates global machine settings and owns configuration inspection and updates.
- `src/config-command.ts` exposes scoped human configuration while preserving agent-managed automation.
- `src/dependencies.ts` switches dependency installations and maintains Python environment links.
- `src/completion.ts` derives shell completion from command definitions and global option metadata.
- `src/shell.ts` opens the selected development shell or runs a command in it.
- `src/checks.ts` runs portable configured check roles and selected native, Guix, Nix, or Dev Container environments.
- `src/check-plan.ts` selects stages, scoped roots, setup sessions, and coverage variants.
- `src/toolchains.ts` reads native tool pins, resolves package-manager commands, and verifies tools inside check
  environments.
- `src/formatting.ts` bundles canonical Markdown/YAML formatting and scopes batch operations to registered records.
- `src/record-document.ts` owns prose-record frontmatter, metadata schemas, and serialization.
- `src/documentation.ts` and `src/validation.ts` own documentation and structural checks.
- `src/feedback.ts` stores local feedback in the platform data directory; `src/commit.ts` validates change-message
  policy.
- `src/record-commands.ts` defines record browsing and actions, shared query options, and current-scope ID resolution.
- `src/query-command.ts` preserves literal query text after the command-line "--" separator.
- `src/main.ts` owns the hierarchical command interface and routing.
- `tests` exercises both project layouts, every record type, contextual help, skill activation, and safe cleanup.
- `skills` contains shared review, refactor, audit, defect-investigation, experiment, adoption, and CI workflows plus
  environment and language-specific dependency updates.
- `bundle` contains distributable JavaScript.
- `scripts/build-bundle.mjs` builds the bundle; `scripts/check-bundle.mjs` checks it against TypeScript sources.
- `scripts/bundle-licenses.mjs` retains the license notices of bundled dependencies.
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
- `.node-version` and `.tool-versions` pin native host tools.
- `.githooks/pre-commit` checks staged files and verifies the pinned Workbench checkout; `.githooks/commit-msg`
  validates change messages.
- `.gitattributes` excludes generated bundle string literals from Git whitespace checks; bundle parity checks their
  source.
- `examples/languages` contains executable TypeScript, Rust, Python, C, C++, and Go references with optional Guix and
  Nix environments.
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` lock TypeScript dependencies and scripts.
- `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mjs`, and `.prettierrc.json` set code-quality defaults.
- `channels.scm` pins Guix for `manifest.scm`, which lists optional development tools; `.envrc` only loads local
  settings and the launcher path.
- `Makefile` exposes development commands, delegates checks to Workbench, and cleans local outputs and dependencies.
- `src/review.ts` binds human acknowledgment to protected staged content; `src/test-timing.ts` reports advisory suite
  timing.
- `src/doc-examples.ts` verifies executable console examples.
- `scripts/check-native.mjs`, `scripts/check-go.mjs`, `scripts/check-python.mjs`, and `scripts/check-rust.mjs` adapt
  build, coverage, and timing tools.
- `src/native-tools.ts` installs and selects declared native tools; `src/storage.ts` resolves platform user directories.
- `src/miri.ts` validates supplementary dated Rust nightly pins and invokes Miri without changing compiler defaults.
- `src/tool-downloads.ts` verifies upstream artifacts and safely publishes installations; `scripts/native-assets.json`,
  `scripts/llvm-assets.json`, and `scripts/bootstrap-tools.json` record verified acquisition metadata.
- `src/vcpkg.ts` prepares pinned C/C++ dependencies with the selected compiler and ABI-aware caching.
- `src/devcontainers.ts` adapts the locked Dev Container CLI; `.devcontainer` defines the workspace and its OS
  prerequisites.
- `scripts/check-devcontainer.mjs` runs the configured CI roots in that shared container.
- `scripts/ci-plan.mjs`, `scripts/ci-run.mjs`, and `scripts/ci-cache.mjs` share CI setup while retaining all configured
  roots, and reuse pinned tools, dependency downloads, compiled GCC, and Guix source history.
- `workbench/quality.json` declares coverage floors for Workbench TypeScript, including CLI subprocess execution.
- `scripts/test-coverage.mjs`: combine Vitest and copied CLI coverage using the same AST converter and enforce unchanged
  floors.
- `scripts/coverage-summary.mjs` normalizes coverage baselines and presents changes in terminal and CI summaries.
- `scripts/check-coverage-summary.mjs` translates language-native reports into comparable summaries.
- `scripts/clean.mjs` removes configured local artifacts without following links into shared caches.
- `scripts/release-rust.mjs` copies Cargo-reported executables from the build cache into the release directory.
- `scripts/package-workbench.mjs` prepares a local runnable distribution without local settings or generated caches.
- `scripts/check-release.mjs` verifies prepared CLI distributions, language packages, and binaries outside the checkout.
