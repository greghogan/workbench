# Checks and environments

- `scripts/native-pgo.mts`, `scripts/check-pgo.mts`, `scripts/cmake/WorkbenchOptimization.cmake`: Train and verify
  explicit compiler-specific PGO and hardened/analyzed native variants using owned outputs and declared toolchains.
- `scripts/executable-hardening.mts`, `tests/executable_hardening.test.mts`: Inspect native executable protections and
  reject missing protections or malformed metadata.
- `scripts/profile-case.mts`, `scripts/profile-workbench.mts`: Collect separate unprofiled measurements and Node
  CPU/heap captures for representative read-only Workbench operations.
- `scripts/check-reproducibility.mts`: Rebuild frozen application source in independent directories, compare bundle and
  archive bytes, execute rebuilt CLIs, and clean owned temporary source trees.

Resolve configured work, select tools and environments, and coordinate isolated CI.

- `src/rust-cache.ts`, `scripts/check-rust-cache.mts`: Prune recognized artifacts inside owned Rust generations under
  build/session locks and qualify cleanup against real Cargo output and subsequent build reuse.

- `src/consumer-integration.ts`, `src/consumer-integration-fixtures.ts`, `src/consumer-integration-runner.ts`: Exercise
  installed consuming projects, behavioral faults, adoption, hooks, concurrency and offline recovery with isolated
  state, verified shared caches and retained command evidence.
- `src/consumer-integration-installation.ts`, `tests/consumer_installation.test.mts`: Exercise PATH-selected installed
  commands, isolated user and system prefixes, immutable project pins, and real npm/Git cache reuse.
- `src/consumer-source.ts`, `scripts/source-snapshot.mts`, `tests/source_snapshot.test.mts`: Rehearse source-only
  developer setup from private Git snapshots without modifying the caller's index or borrowing generated helpers.
- `tests/launcher_cache.test.mts`: Reject incomplete or conflicting npm installations and reuse only the exact pinned
  repository and revision from npm-owned cache metadata.
- `src/npm-cache.ts`, `src/npm-command.ts`, `src/tool-pin.ts`, `tests/npm_command.test.mts`: Resolve npm entry points,
  validate immutable source bindings and stream bounded cache metadata without depending on npm's cache-key algorithm.
- `src/executable-identity.ts`, `tests/executable_identity.test.mts`: Inspect the actual selected executable and runtime
  through a versioned public command.
- `src/distribution-source-manifest.ts`, `tests/distribution_manifest.test.mts`: Retain and identify the original source
  manifest bound to each release candidate.
- `src/consumer-integration-scenarios.ts`: Record independent installation/compiler suites and block dependent cases
  after prerequisite failures.
- `src/windows-batch.ts`: Encode literal arguments across the Windows command processor and batch-shim boundaries.
- `scripts/check-consumers.mts`, `tests/consumer_integration.test.mts`: Provide the independently invocable integration
  check and fast regressions for its execution and CI selection.

| Paths                                                                     | Responsibility                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tool-profiles.ts`                                                    | Resolves named compiler/runtime selections and the roots and platforms where they apply.                                                                                                                                     |
| `src/ci.ts`                                                               | derives CI coverage and installation versions from configured language roots and native pins.                                                                                                                                |
| `scripts/ci-plan-contract.mts`                                            | validate and type hosted matrix output and define intentional job skips.                                                                                                                                                     |
| `scripts/ci-plan.mts`                                                     | validates the complete configured hosted matrix and presents its coverage.                                                                                                                                                   |
| `scripts/ci-status.mts`                                                   | requires validation and every selected hosted job to succeed.                                                                                                                                                                |
| `src/ci-targets.ts`                                                       | catalogs configured targets and groups shared hosted setup without dropping roots.                                                                                                                                           |
| `src/ci-runtime.ts`                                                       | selects verified compatibility runtimes independently of development pins.                                                                                                                                                   |
| `src/local-ci.ts`                                                         | selects Linux x64 targets and coordinates isolated jobs and combined rehearsal reports.                                                                                                                                      |
| `src/local-ci-workers.ts`                                                 | bounds concurrent worker admission and drains active jobs before interruption.                                                                                                                                               |
| `scripts/ci-lifecycle.mts`                                                | owns interruption across preparation, admitted commands, and cleanup.                                                                                                                                                        |
| `src/execution-resources.ts`                                              | resolves optional check worker limits, group admission, and CPU budgets for local CI.                                                                                                                                        |
| `src/cache-lock.ts`                                                       | serializes cache writers, protects active check logs during pruning, and preserves uncertain locks.                                                                                                                          |
| `scripts/cache-ownership.mts`                                             | restores shared cache ownership without following links or failing on removed entries.                                                                                                                                       |
| `scripts/cpu-budget.mts`                                                  | supply language worker controls from one job allocation.                                                                                                                                                                     |
| `scripts/ci-worker-request.mts`                                           | validate and type private worker requests.                                                                                                                                                                                   |
| `src/ci-workspace.ts`                                                     | owns snapshot isolation, workspace locking, disposable resources, and cleanup recovery.                                                                                                                                      |
| `src/compilers.ts`                                                        | validates C/C++ standards, compiler families, support minima, and compiler selections.                                                                                                                                       |
| `src/mvsc.ts`                                                             | selects pinned Microsoft toolsets and Windows SDKs for MSVC and Clang, constructs isolated SDK paths, and fingerprints serviced binaries.                                                                                    |
| `src/environments.ts`                                                     | owns environment names, local execution preferences, and active-shell boundaries.                                                                                                                                            |
| `src/builds.ts`                                                           | owns build identities, generation validation, storage paths, native tool controls, locking, and scoped cleanup.                                                                                                              |
| `src/image-retention.ts`                                                  | retires superseded local prepared images only after verified activation and fresh reference checks.                                                                                                                          |
| `src/build-retention.ts`                                                  | selects superseded owned build generations using verified replacements, activity and retention limits.                                                                                                                       |
| `src/build-cache.ts`                                                      | groups owned checkout caches and the virtual Tools project, then selects and confirms recursive cleanup.                                                                                                                     |
| `src/cache-prune-selection.ts`                                            | derives the pure selection model used by the prune menu, returned deletion set, and confirmation totals.                                                                                                                     |
| `src/prepared-images.ts`                                                  | coordinates locked revalidation and explicit local or GHCR image deletion.                                                                                                                                                   |
| `src/image-contract.ts`                                                   | owns prepared image identities, profile locks, protection reasons, and backend-specific report types.                                                                                                                        |
| `src/local-images.ts`                                                     | records local image ownership and inventories selected Docker references and container protection.                                                                                                                           |
| `src/registry-images.ts`, `src/image-process.ts`, `src/docker-query.ts`   | inspect OCI manifests asynchronously with acquisition retries, and explicitly managed registry versions through bounded metadata queries.                                                                                    |
| `src/image-input-validation.ts`                                           | checks declared managed dependency files against selected profile inputs.                                                                                                                                                    |
| `src/windows-host.ts`                                                     | normalizes Windows Git installations and platform paths for native check environments.                                                                                                                                       |
| `scripts/split-prepared-inputs.mts`                                       | partitions prepared native inputs into tool and dependency image layers.                                                                                                                                                     |
| `src/tool-cache.ts`                                                       | inventories shared native, Rustup, and uv installations, protects selected toolsets, and delegates manager-owned removal.                                                                                                    |
| `src/tool-references.ts`                                                  | records tool requirements with cached results and refreshes their references automatically during pruning.                                                                                                                   |
| `src/tool-requirements.ts`                                                | normalizes, validates, and matches shared tool identities for active commands and retained results.                                                                                                                          |
| `src/tool-cache-lock.ts`, `src/cache-size.ts`                             | coordinate shared-tool maintenance with build admission and collect approximate cache sizes without following links.                                                                                                         |
| `src/shell.ts`                                                            | opens the selected development shell or runs a command in it.                                                                                                                                                                |
| `src/shell-session.ts`                                                    | validates typed session requests, selects the execution shell, and owns session variables, private launchers, child signals, and cleanup.                                                                                    |
| `src/checks.ts`                                                           | runs portable configured check roles and selected native, Guix, Nix, or Dev Container environments.                                                                                                                          |
| `src/check-gates.ts`                                                      | Coordinates commit, online, and combined local gates, including the optional connectivity probe.                                                                                                                             |
| `src/check-plan.ts`                                                       | selects stages, scoped roots, setup sessions, and coverage variants.                                                                                                                                                         |
| `src/check-cache.ts`, `src/check-inputs.ts`, `src/check-source-policy.ts` | classifies code inputs, fingerprints source/tool/environment evidence, and refreshes security checks during local reuse.                                                                                                     |
| `src/check-environment.ts`                                                | Constructs native tool environments from declared inputs, selected SDKs and root-specific budgets, and identifies external configuration inputs.                                                                             |
| `src/check-runner.ts`, `src/check-progress.ts`                            | schedules independent check groups within the job limit and applies optional worker caps, coordinates worker cancellation, and retains timed completions, redraws active tasks, and coordinates authenticated check results. |
| `src/check-cancellation.ts`                                               | cancels checks and development commands, escalating process-tree shutdown while retaining ownership until completion.                                                                                                        |
| `.github/workflows/checks.yml`                                            | runs four native platform jobs and project-wide prepared Nix/Guix environments.                                                                                                                                              |
| `.github/actionlint.yaml`                                                 | lists verified hosted-runner labels absent from the pinned validator's built-in list.                                                                                                                                        |
| `scripts/ci-run.mts`                                                      | executes shared native, compatibility, managed-environment, and standalone release phases.                                                                                                                                   |
| `scripts/ci-contract.mts`                                                 | defines target variants, phases, and execution selections.                                                                                                                                                                   |
| `scripts/ci-layout.mts`                                                   | defines cache locations and forwarded CI variables.                                                                                                                                                                          |
| `scripts/ci-results.mts`                                                  | defines the result protocol, persists target/infrastructure outcomes, and collects attempt evidence.                                                                                                                         |
| `scripts/ci-reports.mts`                                                  | collects only reports produced by the current target.                                                                                                                                                                        |
| `scripts/ci-linux`                                                        | contains the authenticated Ubuntu bootstrap image and local target/report coordinator.                                                                                                                                       |
| `src/devcontainers.ts`, `.devcontainer`                                   | adapts the locked Dev Container CLI with private startup scratch directories and cleanup; `.devcontainer` defines the workspace and its OS prerequisites.                                                                    |
| `src/ci-cache-inspection.ts`, `scripts/ci-cache.mts`                      | batches read-only installation and source inspection, then derives hosted retention paths and cache identities.                                                                                                              |
| `scripts/ci-guix-bootstrap.mts`, `scripts/ci-guix-bootstrap.scm`          | retain and import signed pinned Guix runtime closures on disposable hosted runners.                                                                                                                                          |
| `src/profile-schema.ts`                                                   | validates named development and release profile declarations.                                                                                                                                                                |
| `src/development.ts`                                                      | lists profiles and persists local development selection.                                                                                                                                                                     |
| `src/development-images.ts`                                               | presents prepared-image status and coordinates separately selected preparation and publication through the shared operation runner.                                                                                          |
| `src/release-profiles.ts`                                                 | prepares configured artifacts, verifies relocated copies, and records provenance.                                                                                                                                            |
| `scripts/ci-native-prerequisites.mts`                                     | prepares hosted SDK dependencies for native Ruby and PHP runtimes.                                                                                                                                                           |
| `src/compatibility-checks.ts`                                             | selects and describes project-owned compatibility commands from the selected language definition.                                                                                                                            |
| `scripts/ci-cache-metrics.mts`                                            | records cache footprint and elapsed verification-window evidence.                                                                                                                                                            |
| `.github/workflows/publication.yml`                                       | separately prepares, natively verifies, and publishes development images with package write authority.                                                                                                                       |
| `src/offline-profiles.ts`                                                 | prepares, verifies, and explicitly publishes offline development images and tracks input identities in user-cache receipts.                                                                                                  |
| `scripts/ci-image.mts`                                                    | share the authenticated native CI image recipe and platform checks.                                                                                                                                                          |
| `scripts/ci-hosted.mts`                                                   | Runs the exact configured targets on a hosted native platform or in its prepared environment.                                                                                                                                |
| `scripts/prepare-development.mts`                                         | Prepares toolchains, dependency archives and pnpm policy metadata, and verifies fresh offline builds.                                                                                                                        |

- `src/managed-inputs.ts`, `src/managed-input-environment.ts`, `src/managed-registry.ts`: Validate realized dependency
  sources and provide local acquisition interfaces to language package managers.
- `scripts/managed-check-inputs.mts`, `scripts/managed-input-recipes.mts`, `scripts/refresh-managed-inputs.mts`: Derive
  standalone Nix/Guix source packages and refresh pinned proof metadata.
- `scripts/dependency-identity.mts`: Shares dependency-focused package-manifest identities between image selection and
  managed-input generation and validation; other source formats retain exact-byte identities.
- `src/managed-image.ts`, `scripts/prepare-managed-development.mts`, `scripts/prepare-host-managed-development.mts`,
  `scripts/prepare-nix-profiles.mts`: Assemble managed images in an installed manager's host store or a Docker fallback,
  retaining separate per-root profiles through one dependency graph per builder.
- `src/container-references.ts`: Validates explicit OCI repository locations and tagged image references.
- `src/managed-profiles.ts`, `scripts/guix-profile-command.mts`: Register persistent host development profiles, replace
  Guix environment roots transactionally, and release registrations during dependency pruning.
- `scripts/pack-guix-image.mts`, `.devcontainer/guix/image.json`: Validate and apply declarative Guix image layout,
  keeping pack contents independent of orchestration and cache settings.
- `src/image-finalization.ts`: Finalizes imported image metadata and account files without rebuilding or shared BuildKit
  cache.
- `src/buildkit.ts`, `scripts/container-tools/buildkit-image.txt`: Own pinned, project-scoped Docker builders,
  persistent BuildKit state, private client configuration, and verified cleanup.
- `src/builder-cache.ts`: Inventories Docker builder stores and revalidates ownership and active use before explicit
  grouped volume removal.
- `scripts/builder-store-gc.mts`, `tests/builder_store_gc.test.mts`: Retain owned private-store roots and collect
  unreachable Nix/Guix packages after successful container assembly.
- `scripts/prepare-screen-reader.mts`, `scripts/check-screen-reader.mts`, `scripts/screen-reader-assets.json`: Prepare
  verified platform browsers and Windows NVDA/macOS VoiceOver tools and retain real screen-reader workflow evidence from
  the disposable demonstration.
- `scripts/check-workflows.mts`: Validates workflow files and project runner configuration without requiring Git
  metadata.

Local CI integration scenarios are independently scheduled in `tests/local_ci_execution.test.mts`,
`tests/local_ci_failures.test.mts`, `tests/local_ci_reports.test.mts`, and `tests/local_ci_lifecycle.test.mts`.
`tests/fixtures/local-ci-execution.mts` owns their isolated adapter fixtures, failure assertions, and cleanup.

Check integration suites separate cache inputs, coordination recovery, stage selection, online checks, command entry
points, CI target planning, and Git snapshot execution. `tests/fixtures/check-cache.mts`,
`tests/fixtures/check-coordination.mts`, `tests/fixtures/check-stages.mts`, and `tests/fixtures/ci-cache.mts` create
their per-test state and register suite-local cleanup.

- `src/cache-prune-progress.ts`: Reports completed cache deletions and elapsed time, animating terminal progress while
  asynchronous removal retains its ownership locks.
- `src/check-coordination.ts`, `src/process-lock.ts`: Serialize gates for one checkout, retain child ownership through
  cancellation, require explicit receipts for supervised jobs, retain uncertain termination, and recover only proven
  abandoned process locks before rechecking evidence.
- `src/check-order.ts`, `src/check-resources.ts`: Validate explicit ordering, derive selected session dependencies, and
  share dependency-aware group limits and optional worker caps across scheduling, inspection, and evidence fingerprints.
- `src/check-control.ts`: Accepts only a session's private, ordered wrapper records as readiness and completion signals.
- `scripts/managed-process.mts`: Own preparation child lifetimes, bounded capture, cancellation, safe shutdown despite
  uncertain ownership, release only after confirmed drainage, and command discovery.
- `scripts/managed-contract.mts`: Defines builder cache identities, volume layouts, and validated preparation plans.
- `scripts/managed-system.mts`: Selects target systems and evaluates Guix definitions in the target system context.
- `scripts/managed-source-contract.mts`, `scripts/managed-files.mts`: Validate source declarations and atomically
  replace generated metadata after acquisition and generation finish.
- `scripts/verify-managed-preparation.mts`: Explicitly verifies two tiny host-managed profiles in a real offline Docker
  image and releases its temporary profile roots and image tags.

- `scripts/prepare-guix-profiles.mts`: Realizes independent Guix channel groups, retains per-root profiles and matching
  runtimes, and passes only realized store paths to image assembly.

- `src/check-output.ts`: Captures command output and formats compact coverage changes and advisory warnings beside
  completed checks.
- `src/check-report.ts`, `scripts/check-detail-data.mts`: Define validated check details and versioned execution
  reports, including bounded diagnostics and atomic publication.
- `src/log-storage.ts`, `tests/log_storage.test.mts`: Retain complete parent and child logs, verify Zstandard
  compression, read compressed logs, and prune whole completed runs by age and stored size while preserving active work.
- `src/log-run.ts`, `src/log-codec.ts`, `src/log-retention.ts`: Define ownership receipts, bounded native and external
  Zstandard lifetimes, asynchronous inventory, pure retention selection, and locked whole-run removal.
- `src/log-recovery.ts`, `tests/log_lifecycle.test.mts`: Inspect exact retained evidence and enforce reviewed recovery
  and deletion, refusing live owners and preserving uncertain evidence.
- `src/retained-process-logs.ts`: Own private stdout/stderr creation, independent redacted draining, and sink closure
  for check and CI workers.
- `src/check-protocol.ts`: Validate typed coordinator/worker messages before admission or evidence publication.
- `src/offline-verification.ts`: Separates source-specific verification proofs from immutable image identity, including
  external distribution bytes.
- `scripts/pnpm-metadata.mts`: Retains locked package policy metadata through a disposable importer and the verified
  package manager.
- `scripts/native-host-requirements.mts`: Shares internal host SDK requirements between CI provisioning and clean check
  environment construction.
- `browser.nix`, `browser.scm`, `tests/browser_toolchain.test.mts`: Package the pinned browser test engine with managed
  Linux runtime closures and verify its native platform coverage and pairing with the locked Playwright driver.

- `scripts/compiler-catalog.mts`, `src/native-installation.ts`: Define compiler capabilities and explicit artifact,
  runtime-manager, installed-SDK, and unavailable installation providers.
- `scripts/native-c-checks.mts`, `scripts/cmake/WorkbenchCompiler.cmake`: Share native C/C++ check orchestration and
  standalone compiler policy across both references.
- `scripts/native-coverage.mts`: Canonicalize LLVM source selections and reject reports that silently fall back to
  instrumented files outside the requested scope.
- `scripts/windows-utf8-console.mts`: Isolate Microsoft compiler output encoding so Ninja can retain Unicode dependency
  paths without changing the user's console or concurrent builds.
- `scripts/windows-arguments.mts`: Share executable argument quoting while keeping command-shell escaping at the
  batch-file boundary.
- `scripts/native-cpu.h`, `scripts/native-cpu-test.c`: Supply copied, independently tested CPU capability predicates.
- `scripts/owned-child.mts`, `scripts/owned-scratch.mts`: Own child process shutdown, bounded query capture, scratch
  lifetime, and conservative abandoned-run reclamation.
- `src/consumer.ts`, `src/consumer-environment.ts`, `src/consumer-integration-plan.ts`,
  `src/consumer-integration-profile.ts`, `src/consumer-integration-report.ts`: Separate integration tooling from
  packaging; isolate fixture environments, plan compiler profiles against one artifact, execute real application
  journeys, and checkpoint typed profile/case/command evidence.

- `src/check-configuration.ts`, `src/check-preparation.ts`, `src/check-invocation.ts`, `src/check-command.ts`,
  `src/check-finalization.ts`: Separate declared checks, named preparation requests, environment invocation generation,
  execution, and visible post-check maintenance phases.
- `src/tool-adapters.ts`: Associate built-in tool verification probes, installation strategies, dependencies, and native
  environment contributions.
- `scripts/work-admission.mts`, `tests/work_queue.test.mts`: Define dynamic work queues with failure draining and
  admission leases that let processors join a future jobserver without owning its transport.
- `scripts/test-failures.mts`: Keep bounded failed-test assertions in retained gate excerpts.

- `scripts/runtime-parsers.mts`: Share one self-contained TOML/YAML parser runtime across copied managed-input helpers.
- `scripts/managed-image-import.mts`, `tests/managed_image_import.test.mts`: Serialize managed archive imports and
  remove operation-owned source tags while preserving preexisting tags.

| Path                                                                           | Responsibility                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/native-platform.yml`, `.github/actions/ci-cache/action.yml` | Acquires verified inputs before independent complete native operations and preserves platform-specific cache boundaries. |
| `scripts/ci-platform.mts`, `scripts/ci-operations.mts`                         | Groups configured target phases by operation and profile, rejecting missing or duplicated work.                          |
| `src/ci-checks.ts`, `scripts/check-network.mts`                                | Executes fresh offline and online partitions of the same configured CI gate.                                             |
| `src/ci-images.ts`, `scripts/ci-image-transfer.mts`                            | Requires published, input-bound CI images and checks availability for every configured image platform.                   |
| `scripts/ci-candidate.mts`, `scripts/ci-release-ready.mts`                     | Binds the shared portable candidate to successful complete CI and immutable source identity.                             |
| `.github/workflows/release.yml`, `scripts/publish-release.mts`                 | Explicitly promotes the exact tested main candidate to GitHub Releases and verifies downloaded published bytes.          |

- `scripts/ci-execution.mts`: Execute the shared target-phase, cancellation and report lifecycle for hosted runners,
  guests and local CI.
- `scripts/ci-image-contract.mts`, `tests/ci_contracts.test.mts`: Require immutable published identities for image
  handoff, rejecting local-only images and unrelated registry repositories.
- `tests/ci_image_availability.test.mts`: Verify repository-configured image platforms, deduplicated manifest queries,
  and distinct missing-image and registry-access failures without acquisition or preparation.
- `scripts/release-contract.mts`, `scripts/github-release.mts`: Separate release proof validation from authenticated
  GitHub transport, including exact pending-draft and published-tag lookup, retried read operations, and private
  complete-download publication.

- `src/development-locks.ts`: Inspects preparation ownership and guards explicit digest-bound recovery against active or
  uncertain process scopes and container work.
- `scripts/accessibility-criteria.mts`: Maps automated browser results to partial WCAG criterion evidence without
  claiming full conformance.

- `src/image-emulation.ts`: Checks enabled persistent binfmt registration for explicit foreign image assembly and
  offline execution.

- `src/check-targets.ts`, `tests/check_targets.test.mts`: Normalize and explain CI target selection consistently for
  checks, coverage, and required setup.

- `src/cli/checks.ts`, `src/cli/development.ts`: Register gate, CI, environment, and shell interfaces around shared
  execution services.
- `src/execution-context.ts`: Carry operation-local environment selections across asynchronous work and into child
  commands without changing the process environment.

- `src/container-startup.ts`: Validate container ownership and drain bounded startup processes independently of profile
  preparation.

- `src/ci-hosting.ts`, `src/ci-destinations.ts`: Define supported CI providers, canonical Git project identities,
  destination matching, registry defaults, and strict destination configuration.
- `src/ci-workflows.ts`, `src/ci-hosted-target.ts`, `tests/ci_hosting.test.mts`, `tests/ci_hosted_target.test.mts`:
  Generate project-owned GitHub and GitLab workflows from shared target definitions and execute native or verified
  prepared-image targets with retained reports.
- `src/registry-management.ts`, `tests/gitlab_registry.test.mts`: Separate GHCR and GitLab inventory, exact identity
  revalidation, and explicit deletion from provider-neutral Docker image transport.

- `src/ci-job-plan.ts`, `src/ci-hosted-jobs.ts`, `tests/ci_hosted_jobs.test.mts`: Share platform preparation and
  configured operation graphs, bind handoffs to exact source snapshots, and reject stale or foreign preparation.
- `src/registry-management-contract.ts`, `src/registry-api.ts`, `tests/registry_api.test.mts`,
  `tests/registry_capabilities.test.mts`: Validate independent API capabilities and own bounded, cancellable provider
  requests and complete deletion prevalidation.
- `src/ci-validation.ts`, `tests/ci_validation.test.mts`: Supply local syntax validation and explicitly selected GitLab
  server schema checks without creating pipelines.
- `src/consumer-ci.ts`: Maintains packaged-CLI CI setup, workflow lint, and native handoff integration scenarios
  alongside installation and language journeys.
- `scripts/ci-actions.json`, `scripts/ci-actions.mts`: Own immutable workflow component pins shared by generation,
  maintenance discovery, derived workflow publication and strict workflow checks.

- `scripts/network-retry.mts`, `scripts/network-command.mts`: Share bounded, cancellable network acquisition retries,
  response classification, safe command replay and retained failure causes.
- `scripts/ci-acquire.mts`, `scripts/ci-errors.mts`: Apply acquisition policy and actionable annotations and summaries
  at hosted CI boundaries without replaying tests.
- `tests/network_retry.test.mts`: Exercise recovery, permanent failures, cancellation, rate limits and real acquisition
  subprocess behavior.

- `scripts/image-acquisition.mts`: Preserve the active process owner and distinguish unavailable registries from missing
  prepared images during shared registry pulls.

- `src/failure-excerpt.ts`: Scans failed logs with bounded memory and preserves source diagnostics alongside the final
  outcome, prioritizing source causes over general warning floods and honoring cancellation; `src/check-output.ts`
  removes check protocol records before presentation.
- `scripts/java-test-reports.mts`: Replace complete Java test report sets with run outcomes and rollback, preserving
  previous evidence when replacement cannot complete.
- `scripts/java-check.mts`: Run shared frozen Java checks with invocation-owned sibling libraries, per-root formatting,
  complete test reports, and verified application packaging.
- `scripts/windows-process.mts`, `scripts/windows-process-launch.mts`: Supervise Windows commands with creation-time job
  membership, authenticated control-channel ownership, preserved streams, and explicit job-empty evidence.
- `tests/windows_process.test.mts`, `tests/native_tool_selection.test.mts`: Verify Windows process protocol and native
  process lifetime, and reject unresolved language tool selections before runner or acquisition effects.
- `src/consumer-integration-java.ts`: Extends Java's maintained consumer journey with direct/transitive runtime
  dependencies, missing-library rejection, and stale-dependency removal, using the starter's existing artifact pins.
  Exercises source-built sibling libraries against stale private cache entries, unchanged versions, frozen plugin
  checksums, and standalone packaged execution.
- `tests/java_sources.test.mts`, `tests/java_reports.test.mts`, `tests/java_execution.test.mts`: Verify concurrent-edit
  protection during Java formatting, complete report replacement, failure recovery, and configured runner behavior.
