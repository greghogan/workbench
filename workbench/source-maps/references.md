# Examples and quality support

- `scripts/document-properties.mts`, `scripts/property-case.mts`, `scripts/check-fuzz.mts`,
  `scripts/check-mutations.mts`, `tests/document_properties.test.mts`, `tests/property_exploration.test.mts`: Exercise
  generated document/scope inputs, reproducible exploration, deliberate contract defects, and partial-failure
  regressions.
- `scripts/check-security-results.mts`, `tests/security_results.test.mts`, `.github/codeql.yml`: Gate security analysis
  on complete, successful SARIF evidence and enforce authored-source security findings.

- `scripts/maintenance`: Owns development-input discovery, reviewed plans, publication, and lock-refresh recovery; its
  JavaScript is generated locally.

- `scripts/maintenance/main.mts`, `scripts/maintenance/locks.mts`: Plans, applies, and resumes repository maintenance
  and orchestrates verified lock managers.
- `scripts/maintenance/contract.mts`, `scripts/maintenance/workspace.mts`, `scripts/maintenance/inventory.mts`: Defines
  typed update identities, structured locations, and independent version authorities.
- `scripts/maintenance/plan.mts`, `scripts/maintenance/adapters.mts`, `scripts/maintenance/sources.mts`: Selects
  eligible releases from authoritative indexes and records plan preconditions.
- `scripts/maintenance/apply.mts`, `scripts/maintenance/publication.mts`, `scripts/maintenance/operation.mts`: Binds
  scoped tool/platform publication identities, serializes updates, and retains conflict and recovery evidence.
- `scripts/maintenance/edits.mts`, `scripts/maintenance/syntax.mts`, `scripts/maintenance/native.mts`,
  `scripts/maintenance/php.mts`: Preserves source formatting and trust metadata while decoding publisher metadata,
  rendering resolved native recipes, and reconciling fresh Maven checksums.
- `scripts/tooling-artifacts.mts`, `scripts/setup-development.mts`: Owns generated-file classification and development
  setup.
- `scripts/java-sources.mts`: Enforces canonical Java source line endings and publishes formatter changes without
  overwriting concurrent edits.

- `scripts/managed-inputs.mts`: Derives standalone managed check inputs, Guix crate origins, and React runtime
  inventories from dependency locks.
- `scripts/python-checks.mts`: Runs frozen Python checks and installs the exported locked graph from declared local
  wheels in managed environments.
- `scripts/package-managed.mts`, `scripts/verify-managed.mts`: Prepare example Nix closures and Guix portable packs and
  verify their behavior in isolated containers.

Independent language examples, skills, tests, and development tooling.

| Paths                                                                                                                                                                      | Responsibility                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `languages`                                                                                                                                                                | owns reusable per-language metadata, automation, and native artifact filters.                                                                                                                                                              |
| `examples/languages/java/scripts/check.mts`                                                                                                                                | delegates frozen Java checks and packaging to Maven.                                                                                                                                                                                       |
| `scripts/java-coverage.mts`                                                                                                                                                | normalizes JaCoCo coverage summaries.                                                                                                                                                                                                      |
| `examples/frameworks/react`                                                                                                                                                | is a standalone React application using the TypeScript suite on all configured native platforms.                                                                                                                                           |
| `scripts/source-checkout.mts`, `tests/fixtures/cache-checkout.mts`                                                                                                         | copies full source checkouts for packaging and coverage, and minimal manifests for cache-planning tests.                                                                                                                                   |
| `scripts/ci-linux/job.mts`                                                                                                                                                 | runs one target with its isolated workspace, logs, and result contract.                                                                                                                                                                    |
| `.pnpmfile.cjs`                                                                                                                                                            | applies Workbench storage to direct pnpm commands; TypeScript and React include project-owned copies.                                                                                                                                      |
| `tests`                                                                                                                                                                    | exercises both project layouts, every record type, contextual help, skill activation, and safe cleanup.                                                                                                                                    |
| `skills`                                                                                                                                                                   | contains shared planning, changeset/project review, defect-investigation, experiment, adoption, rebase, and CI workflows plus CI version updates (including Debian bases), environment updates, and language-specific dependency updates.  |
| `scripts/check-shell`                                                                                                                                                      | provides shell format and lint roles used by local checks and the Git adapter.                                                                                                                                                             |
| `scripts/check-harnesses.mts`                                                                                                                                              | verifies real Codex and Claude instruction and skill loading against a local model stub in disposable repositories and application homes.                                                                                                  |
| `scripts/evaluate-skills.mts`                                                                                                                                              | runs opt-in model evaluations with isolated application state and retained review evidence.                                                                                                                                                |
| `scripts/skill-evaluation-cases.mts`, `scripts/skill-evaluation-policy.mts`                                                                                                | owns fixtures and behavioral grading.                                                                                                                                                                                                      |
| `.node-version`, `.tool-versions`                                                                                                                                          | pin native host tools.                                                                                                                                                                                                                     |
| `.gitattributes`                                                                                                                                                           | excludes generated bundle string literals from Git whitespace checks; bundle parity checks their source.                                                                                                                                   |
| `examples/languages`                                                                                                                                                       | contains executable TypeScript, JavaScript, Java, Rust, Python, C, C++, Go, Ruby, and PHP references with optional Guix and Nix environments.                                                                                              |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`                                                                                                                    | lock TypeScript dependencies and scripts.                                                                                                                                                                                                  |
| `tsconfig.json`, `eslint.config.mts`, `vitest.config.mts`, `.prettierrc.json`                                                                                              | set code-quality defaults.                                                                                                                                                                                                                 |
| `channels.scm`, `manifest.scm`, `.envrc`                                                                                                                                   | pins Guix for optional development tools; independent `.envrc` hooks load root-specific storage and personal settings, adding the checkout launcher path directly.                                                                         |
| `Makefile`                                                                                                                                                                 | exposes development commands, delegates checks to Workbench, and cleans local outputs and dependencies.                                                                                                                                    |
| `examples/languages/c/scripts/check.mts`, `examples/languages/go/scripts/check.mts`, `scripts/check-python.mts`, `scripts/check-rust.mts`, `tests/native_release.test.mts` | adapt build, coverage, and timing tools. Native checks also verify optimized static-library linkage, unsupported LTO combinations, and release behavior before preparing artifacts; `tests/native_release.test.mts` covers failure safety. |
| `scripts/ci-linux/bootstrap.py`                                                                                                                                            | authenticates and privately stages the initial Node runtime before activation.                                                                                                                                                             |
| `workbench/quality.json`                                                                                                                                                   | declares coverage floors for Workbench TypeScript, including CLI subprocess execution.                                                                                                                                                     |
| `scripts/node-coverage-reports.mts`                                                                                                                                        | Validates raw Node coverage reports and produces bounded diagnostics without source contents.                                                                                                                                              |
| `scripts/test-coverage.mts`                                                                                                                                                | combines Vitest and copied CLI coverage using exact map matching and bounded execution merging, retains phase timings, and enforces unchanged floors.                                                                                      |
| `scripts/coverage-summary.mts`                                                                                                                                             | normalizes coverage baselines and presents changes in terminal and CI summaries.                                                                                                                                                           |
| `scripts/check-coverage-summary.mts`                                                                                                                                       | translates language-native reports into comparable summaries.                                                                                                                                                                              |
| `scripts/clean.mts`                                                                                                                                                        | removes configured local artifacts without following links into shared caches.                                                                                                                                                             |
| `scripts/release-rust.mts`, `examples/languages/rust/scripts/release-verify.mts`, `tests/rust_release.test.mts`                                                            | build and test native or explicit musl releases, then verify standalone behavior, ELF linkage, and offline distribution execution before acceptance; regressions cover failure safety and linkage inspection.                              |
| `docs/execution.md`                                                                                                                                                        | documents CPU allocation, language controls, CI isolation, and cache ownership.                                                                                                                                                            |
| `docs/profiles.md`                                                                                                                                                         | documents profile selection, packaging recipes, and completion installation.                                                                                                                                                               |
| `examples/languages/ruby/scripts/check.mts`                                                                                                                                | delegates Ruby quality and packaging roles to locked tools.                                                                                                                                                                                |
| `scripts/ruby-coverage.mts`                                                                                                                                                | normalizes SimpleCov production line and branch coverage.                                                                                                                                                                                  |
| `examples/languages/php/scripts/check.mts`                                                                                                                                 | adapts Composer, analysis, tests and packaging to Workbench roles.                                                                                                                                                                         |
| `examples/languages/php/.composer/verify/src/VerifyPlugin.php`                                                                                                             | checks Composer distribution SHA-256 before extraction.                                                                                                                                                                                    |
| `flake.nix`, `flake.lock`                                                                                                                                                  | Root managed tools and their existing Nix input pin.                                                                                                                                                                                       |

- `scripts/values.mts`: Validates shared helper input shapes and required values.
- `scripts/script-entry.mts`: Recognizes direct script execution through filesystem aliases without running imports.
- `scripts/vendor-types.d.mts`: Declares the used upstream coverage API where the package omits types.

- `tests/tsconfig.json`: Checks test fixtures against their test-runtime APIs while the root TypeScript project
  separately checks the application baseline.
- `tests/fixtures/installations.mts`, `tests/fixtures/review-interaction.mts`: Share per-test fixture setup and cleanup
  across isolated installation and review suites while keeping writable state and mocks local to each suite.
- `tests/skill_evaluation.test.mts`: Exercises skill workflows with per-scenario repositories, remotes, and user state.

- `scripts/coverage-processing.mts`: Attributes exact frozen source maps, merges V8 execution ranges, and converts
  independent measured scripts.
- `scripts/coverage-workers.mts`, `scripts/coverage-worker.mts`: Own bounded coverage worker phases, preserve diagnostic
  failures, initialize immutable scan context once, exchange only counters and ranges during scanning, and drain threads
  before raw-report cleanup. Helper source text is read once by the parent before conversion.
- `tests/coverage_workers.test.mts`: Verifies serial/parallel counter equivalence, malformed-report diagnostics, and
  thread cleanup after worker failures.
- `tests/fixtures/coverage-producers.mts`, `tests/coverage_producers.test.mts`: Attribute malformed coverage to owning
  tests and completed processes or threads without collecting command arguments, environment values, or source contents.
- `scripts/link-dependencies.mts`: Links installed dependencies into disposable workspaces while preserving pnpm's
  original virtual-store base across volumes.
- `scripts/process-outcome.mts`: Describes child exit status, signals, and spawn errors without adding command arguments
  or environment values to the diagnostic message.
- `tests/fixtures/process.mts`: Supplies complete mocked process outcomes and consistent fixture success assertions with
  bounded captured output.
- `tests/coverage_failures.test.mts`: Exercises child failures and primary-error preservation across result retention,
  diagnostic writing, cleanup, and timing output failures.

- `scripts/skill-evaluation-rebase.mts`: Builds disposable Git histories and checks rebase, conflict, refusal, and
  policy handoff outcomes.

- `tests/file_reads.test.mts` — Exact bounded read behavior and filesystem rejection boundaries.

- `.github/codeql-queries/workbench.qls`, `scripts/security-lint.mts`, `tests/security_lint.test.mts` — Configure
  security analysis and require explained, narrow exceptions.

- `scripts/engineering-run.mts`, `scripts/optimization-artifact.mts`, `tests/engineering_artifacts.test.mts`,
  `tests/optimization_inputs.test.mts`, `tests/optimization_selection.test.mts`: Own engineering child processes and
  scratch, derive build-input provenance, and publish verified optimization artifacts with rollback.
- `scripts/profile-model.mts`, `scripts/profile-measurement.mts`, `tests/profile_capture.test.mts`: Define named
  profiling cases and validated counters collected from the actual measured process.
- `scripts/rebuild-workbench.mts`, `scripts/compare-artifacts.mts`: Rebuild each frozen checkout with its own tooling
  and retain bounded byte-comparison evidence.
- `scripts/elf.mts`: Decode bounded executable metadata shared by hardening and static Rust release verification.
- `tests/file_reads_faults.test.mts`: Exercise mid-read mutation and simultaneous read/descriptor-cleanup failures.

- `tests/native_tooling.test.mts`: Verifies explicit bootstrap tracking, direct TypeScript CI execution, erasable
  syntax, and retirement of obsolete generated files.

- `scripts/maintenance/go.mts`, `tests/maintenance_go.test.mts`: Discover canonical Go module versions through tagged
  releases and the proxy's pseudo-version fallback, preserving exact pins and semantic ordering.
