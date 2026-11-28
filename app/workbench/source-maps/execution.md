# Checks and environments

- `test/integration/tooling/executable_hardening.test.mts`: Inspect native executable protections and reject missing
  protections or malformed metadata.
- `src/core/storage/rust-cache.ts`: Prune recognized artifacts inside owned Rust generations under build/session locks
  and qualify cleanup against real Cargo output and subsequent build reuse.
- `test/integration/consumers/consumer-integration.ts`, `test/integration/consumers/consumer-integration-fixtures.ts`,
  `test/integration/consumers/consumer-integration-runner.ts`: Exercise installed consuming projects, behavioral faults,
  adoption, hooks, concurrency and offline recovery with isolated state, verified shared caches and retained command
  evidence.
- `test/integration/consumers/consumer-integration-installation.ts`,
  `test/integration/consumers/consumer_installation.test.mts`: Exercise PATH-selected installed commands, isolated user
  and system prefixes, immutable project pins, and real npm/Git cache reuse.
- `test/integration/consumers/consumer-source.ts`, `src/core/execution/snapshots/source-snapshot.mts`,
  `test/integration/tooling/source_snapshot.test.mts`: Rehearse source-only developer setup from private Git snapshots
  without modifying the caller's index or borrowing generated helpers.
- `test/core/distribution/launcher_cache.test.mts`: Reject incomplete or conflicting npm installations and reuse only
  the exact pinned repository and revision from npm-owned cache metadata.
- `src/core/toolchains/npm-cache.ts`, `src/core/toolchains/npm-command.ts`, `src/core/toolchains/tool-pin.ts`,
  `test/core/toolchains/npm_command.test.mts`: Resolve npm entry points, validate immutable source bindings and stream
  bounded cache metadata without depending on npm's cache-key algorithm.
- `src/core/distribution/executable-identity.ts`, `test/core/distribution/executable_identity.test.mts`: Inspect the
  actual selected executable and runtime through a versioned public command.
- `src/core/distribution/distribution-source-manifest.ts`, `test/core/distribution/distribution_manifest.test.mts`:
  Retain and identify the original source manifest bound to each release candidate.
- `test/integration/consumers/consumer-integration-scenarios.ts`: Record independent installation/compiler suites and
  block dependent cases after prerequisite failures.
- `src/core/runtime/windows-batch.ts`: Encode literal arguments across the Windows command processor and batch-shim
  boundaries.
- `test/integration/consumers/consumer_integration.test.mts`: Provide the independently invocable integration check and
  fast regressions for its execution and CI selection.
- `src/core/toolchains/tool-profiles.ts`: Resolves named compiler/runtime selections and the roots and platforms where
  they apply.
- `src/core/execution/ci/ci.ts`: derives CI targets and installation versions, then checks their prepared image recipes
  against the artifact catalog.
- `src/core/execution/ci/ci-targets.ts`: catalogs configured targets and groups shared hosted setup without dropping
  roots.
- `src/core/execution/ci/ci-packages.ts`: plans distinct release packages and verifies them on the target host.

- `src/core/execution/ci/ci-release.ts`: packages release files on each selected target and verifies complete
  transfers before tagged publication.
- `src/core/execution/ci/ci-runtime.ts`: selects verified compatibility runtimes independently of development pins.
- `src/core/execution/ci/local-ci.ts`: selects Linux x64 targets and coordinates isolated jobs and combined rehearsal
  reports.
- `src/core/execution/ci/local-ci-workers.ts`: bounds concurrent worker admission and drains active jobs before
  interruption.
- `src/core/execution/ci/support/ci-lifecycle.mts`: owns interruption across preparation, admitted commands, and
  cleanup.
- `src/core/execution/environments/execution-resources.ts`: resolves optional check worker limits, group admission, and
  CPU budgets for local CI.
- `src/core/storage/cache-lock.ts`: serializes cache writers, protects active check logs during pruning, and preserves
  uncertain locks.
- `src/core/execution/checks/cpu-budget.mts`: supply language worker controls from one job allocation.
- `src/core/execution/checks/machine-admission.ts`, `src/core/execution/checks/host-activity.ts`,
  `test/core/execution/checks/machine_admission.test.mts`: schedule work across projects using shared limits, runnable
  project rotation, and observed CPU and memory pressure.
- `src/core/execution/checks/unix-jobserver-protocol.ts`, `src/core/execution/checks/unix-jobserver-client.ts`,
  `src/server/http/unix-jobserver.ts`: authenticate local ownership, connect check execution to the installed service,
  and retain leases until their command groups finish or recover.
- `src/core/distribution/unix-system-authority.ts`: locate and verify protected Unix service paths.
- `src/core/execution/checks/native-worker-tools.ts`, `src/server/http/unix-worker-pipe.ts`: bind compatible Linux
  and macOS build commands to job-owned FIFOs backed by the shared worker pool.
- `src/core/execution/ci/support/ci-worker-request.mts`: validate and type private worker requests.
- `src/core/execution/ci/ci-workspace.ts`: owns snapshot isolation, workspace locking, disposable resources, and cleanup
  recovery.
- `src/core/toolchains/compilers.ts`: validates C/C++ standards, compiler families, support minima, and compiler
  selections.
- `src/core/toolchains/mvsc.ts`: selects pinned Microsoft toolsets and Windows SDKs for MSVC and Clang, constructs
  isolated SDK paths, and fingerprints serviced binaries.
- `src/core/execution/environments/environments.ts`: owns environment names, local execution preferences, and
  active-shell boundaries.
- `src/core/artifacts/builds.ts`: owns build identities, generation validation, storage paths, native tool controls,
  locking, and scoped cleanup.
- `src/core/artifacts/image-retention.ts`: retires superseded local prepared images only after verified activation and
  fresh reference checks.
- `src/core/storage/build-retention.ts`: selects superseded owned build generations using verified replacements,
  activity and retention limits.
- `src/core/storage/build-cache.ts`: groups owned checkout caches and the virtual Tools project, then selects and
  confirms recursive cleanup.
- `src/core/storage/cache-prune-selection.ts`: derives the pure selection model used by the prune menu, returned
  deletion set, and confirmation totals.
- `src/core/artifacts/prepared-images.ts`: coordinates locked revalidation and explicit local or GHCR image deletion.
- `src/core/artifacts/image-contract.ts`: owns prepared image identities, profile locks, protection reasons, and
  backend-specific report types.
- `src/core/artifacts/local-images.ts`: records local image ownership and inventories selected Docker references and
  container protection.
- `src/core/artifacts/registry-images.ts`, `src/core/artifacts/image-process.ts`, `src/core/artifacts/docker-query.ts`:
  inspect OCI manifests asynchronously with acquisition retries, and explicitly managed registry versions through
  bounded metadata queries.
- `src/core/artifacts/image-input-validation.ts`: checks declared managed dependency files against selected profile
  inputs.
- `src/core/runtime/windows-host.ts`: normalizes Windows Git installations and platform paths for native check
  environments.
- `src/core/toolchains/tool-cache.ts`: inventories shared native, Rustup, and uv installations, protects selected
  toolsets, and delegates manager-owned removal.
- `src/core/toolchains/tool-references.ts`: records tool requirements with cached results and refreshes their references
  automatically during pruning.
- `src/core/toolchains/tool-requirements.ts`: normalizes, validates, and matches shared tool identities for active
  commands and retained results.
- `src/core/toolchains/tool-cache-lock.ts`, `src/core/storage/cache-size.ts`: coordinate shared-tool maintenance with
  build admission and collect approximate cache sizes without following links. Short measurement locks coordinate
  metadata writes with generation and tool deletion while filesystem walks remain unlocked. Accounting locks stay in
  Workbench's cache rather than package-manager installation namespaces, and do not recreate deleted cache groups.
- `src/core/storage/cache-operations.ts`, `src/core/storage/cache-operation-service.ts`,
  `src/core/storage/cache-operation-contract.ts`, `test/core/storage/cache_operations.test.mts`,
  `test/core/storage/cache_operation_service.test.mts`: Retain external operation receipts for interrupted installation
  and deletion, recover before reuse, and share inspected uncertain cleanup between CLI and browser. Tests cover real
  process interruption, partial deletion, replacement destinations, active work, redirected payloads, and exact
  confirmation.
- `src/core/execution/environments/shell.ts`: opens the selected development shell or runs a command in it.
- `src/core/execution/environments/shell-session.ts`: validates typed session requests, selects the execution shell, and
  owns session variables, private launchers, child signals, and cleanup.
- `src/core/execution/checks/checks.ts`: runs portable configured check roles and selected native, Guix, Nix, or Dev
  Container environments.
- `src/core/execution/checks/check-gates.ts`: Coordinates commit, online, and combined local gates, including the
  optional connectivity probe.
- `src/core/execution/checks/check-acquisition.ts`: Runs dependency preparation from the selected working or staged
  snapshot with the check planner.
- `src/core/execution/checks/check-plan.ts`: selects stages, scoped roots, setup sessions, and coverage variants.
- `src/core/execution/checks/check-cache.ts`, `src/core/execution/checks/check-inputs.ts`,
  `src/core/execution/checks/check-input-scope.ts`, `src/core/execution/checks/check-source-policy.ts`: Resolve declared
  input groups and fingerprint source, tool, and environment evidence.
- `src/core/execution/checks/check-cache-plan.ts`, `src/core/execution/checks/check-cache-groups.ts`,
  `src/core/execution/checks/check-isolation.ts`, `src/core/execution/checks/check-macos-isolation.ts`,
  `src/core/execution/checks/check-source-view.ts`,
  `src/core/execution/checks/check-cache-store.ts`: Reuse independent check results, enforce source and offline network
  boundaries, run required prerequisites and fresh security checks, and retain successful evidence for each group.
- `src/core/execution/checks/check-environment.ts`: Constructs native tool environments from declared inputs, selected
  SDKs and root-specific budgets, and identifies external configuration inputs.
- `src/core/execution/checks/check-runner.ts`, `src/core/execution/checks/check-progress.ts`: schedules independent
  check groups within the job limit and applies optional worker caps, coordinates worker cancellation, and retains timed
  completions, redraws active tasks, and coordinates authenticated check results.
- `src/core/execution/checks/check-cancellation.ts`: cancels checks and development commands, escalating process-tree
  shutdown while retaining ownership until completion.
- `src/core/execution/ci/support/ci-contract.mts`: defines target variants, phases, and execution selections.
- `src/core/execution/ci/support/ci-layout.mts`: defines cache locations and forwarded CI variables.
- `src/core/execution/ci/support/ci-results.mts`: defines the result protocol, persists target/infrastructure outcomes,
  and collects attempt evidence.
- `src/core/execution/ci/support/ci-reports.mts`: collects only reports produced by the current target.
- `src/core/artifacts/devcontainers.ts`: adapts the locked Dev Container CLI with private startup scratch directories
  and cleanup; .devcontainer defines the workspace and its OS prerequisites.
- `src/core/execution/ci/ci-cache-inspection.ts`: batches read-only installation and source inspection, then derives
  hosted retention paths and cache identities.
- `src/core/artifacts/profile-schema.ts`: validates named development and release profile declarations.
- `src/core/artifacts/development.ts`: lists profiles and persists local development selection.
- `src/cli/development-images.ts`: presents prepared-image status and coordinates separately selected preparation and
  publication through the shared operation runner.
- `src/core/artifacts/release-profiles.ts`: prepares configured artifacts, verifies relocated copies, and records
  provenance.
- `src/core/execution/checks/compatibility-checks.ts`: selects and describes project-owned compatibility commands from
  the selected language definition.
- `src/core/artifacts/offline-profiles.ts`: prepares, verifies, and explicitly publishes offline development images and
  tracks input identities in user-cache receipts.
- `src/core/artifacts/native-archive.ts`: transfers native tool downloads and package caches, then verifies
  restoration and installation with fresh paths and no network access.
- `src/core/execution/ci/support/ci-image.mts`: share the authenticated native CI image recipe and platform checks.
- `src/core/execution/environments/managed-inputs.ts`, `src/core/execution/environments/managed-input-environment.ts`,
  `src/core/execution/environments/managed-registry.ts`: Validate realized dependency sources and provide local
  acquisition interfaces to language package managers.
- `src/core/execution/environments/managed/managed-check-inputs.mts`: Derive standalone Nix/Guix source packages and
  refresh pinned proof metadata.
- `src/core/toolchains/dependency-identity.mts`: Shares dependency-focused package-manifest identities between image
  selection and managed-input generation and validation; other source formats retain exact-byte identities.
- `src/core/artifacts/managed-image.ts`: Assemble managed images in an installed manager's host store or a Docker
  fallback, retaining separate per-root profiles through one dependency graph per builder.
- `src/core/artifacts/container-references.ts`: Validates explicit OCI repository locations and tagged image references.
- `src/core/artifacts/managed-profiles.ts`: Register persistent host development profiles, replace Guix environment
  roots transactionally, and release registrations during dependency pruning.
- `src/core/artifacts/image-finalization.ts`: Finalizes imported image metadata and account files without rebuilding or
  shared BuildKit cache.
- `src/core/artifacts/buildkit.ts`: Own pinned, project-scoped Docker builders, persistent BuildKit state, private
  client configuration, and verified cleanup.
- `src/core/storage/builder-cache.ts`, `src/core/storage/managed-store-pins.ts`: Inventory shared stores and builder
  caches, and revalidate ownership, active use, and verification evidence before cleanup.
- `src/core/storage/managed-preparation.ts`: Records the project and managed store generation before assembly so an
  interruption can be traced until the image catalog records its pins.
- `test/core/storage/builder_store_gc.test.mts`: Exercise independent release of staging archives and superseded profile
  roots, including interrupted cleanup.
- `src/core/storage/cache-prune-progress.ts`: Reports completed cache deletions and elapsed time, animating terminal
  progress while asynchronous removal retains its ownership locks.
- `src/core/execution/checks/check-coordination.ts`, `src/core/storage/process-lock.ts`: Serialize gates for one
  checkout, retain child ownership through cancellation, require explicit receipts for supervised jobs, retain uncertain
  termination, and recover only proven abandoned process locks before rechecking evidence.
- `src/core/execution/checks/check-order.ts`, `src/core/execution/checks/check-resources.ts`: Validate explicit
  ordering, derive selected session dependencies, and share dependency-aware group limits and optional worker caps
  across scheduling, inspection, and evidence fingerprints.
- `src/core/execution/checks/check-control.ts`: Accepts only a session's private, ordered wrapper records as readiness
  and completion signals.
- `src/core/execution/environments/managed/managed-contract.mts`: Defines builder cache identities, volume layouts, and
  validated preparation plans.
- `src/core/execution/environments/managed/managed-system.mts`: Selects target systems and evaluates Guix definitions in
  the target system context.
- `src/core/execution/environments/managed/managed-source-contract.mts`: Validate source declarations and atomically
  replace generated metadata after acquisition and generation finish.
- `src/core/execution/checks/check-output.ts`: Captures command output and formats compact coverage changes and advisory
  warnings beside completed checks.
- `src/core/execution/checks/check-report.ts`, `src/core/execution/checks/check-detail-data.mts`: Define validated check
  details and versioned execution reports, including bounded diagnostics and atomic publication.
- `src/core/storage/logs/log-storage.ts`, `test/core/storage/logs/log_storage.test.mts`: Retain complete parent and
  child logs, verify native Zstd or gzip compression, read retained logs, and prune completed units by age and stored
  size while preserving active work.
- `src/core/storage/logs/diagnostic-log.ts`, `src/core/storage/logs/log-reader.ts`,
  `test/core/storage/logs/diagnostic_log.test.mts`: Rotate server events and terminal output, read retained segments in
  order, and protect active sessions and interrupted evidence.
- `src/core/diagnostics/terminal-transcript.ts`: Retain redacted service stdout and stderr while preserving console
  output.
- `src/core/storage/logs/log-run.ts`, `src/core/storage/logs/log-codec.ts`, `src/core/storage/logs/log-retention.ts`:
  Define typed ownership receipts, single-pipeline codec lifetimes, complete asynchronous inventories, pure retention
  selection, and locked removal.
- `src/core/storage/logs/log-inventory.ts`, `src/core/storage/logs/log-maintenance.ts`,
  `test/core/storage/logs/log_inventory.test.mts`: Bound sorting memory and open files without truncating discovery, and
  give each diagnostic session one maintenance owner.
- `src/core/storage/logs/log-recovery.ts`, `test/core/storage/log_lifecycle.test.mts`: Inspect exact retained evidence
  and enforce reviewed recovery and deletion, refusing live owners and preserving uncertain evidence.
- `src/core/storage/retained-process-logs.ts`: Own private stdout/stderr creation, independent redacted draining, and
  sink closure for check and CI workers.
- `src/core/execution/checks/check-protocol.ts`: Validate typed coordinator/worker messages before admission or evidence
  publication.
- `src/core/artifacts/offline-verification.ts`: Separates source-specific verification proofs from immutable image
  identity, including external distribution bytes.
- `src/core/toolchains/native/native-host-requirements.mts`: Shares internal host SDK requirements between CI
  provisioning and clean check environment construction.
- `test/core/toolchains/browser_toolchain.test.mts`: Package the pinned browser test engine with managed Linux runtime
  closures and verify its native platform coverage and pairing with the locked Playwright driver.
- `src/core/toolchains/compiler-catalog.mts`, `src/core/toolchains/native/native-installation.ts`: Define compiler
  capabilities and explicit artifact, runtime-manager, installed-SDK, and unavailable installation providers.
- `src/core/runtime/windows-utf8-console.mts`: Isolate Microsoft compiler output encoding so Ninja can retain Unicode
  dependency paths without changing the user's console or concurrent builds.
- `src/core/runtime/windows-arguments.mts`: Share executable argument quoting while keeping command-shell escaping at
  the batch-file boundary.
- `src/core/runtime/owned-child.mts`, `src/core/runtime/owned-scratch.mts`: Own child process shutdown, bounded query
  capture, scratch lifetime, and conservative abandoned-run reclamation.
- `test/integration/consumers/consumer.ts`, `test/integration/consumers/consumer-environment.ts`,
  `test/integration/consumers/consumer-integration-plan.ts`,
  `test/integration/consumers/consumer-integration-profile.ts`,
  `test/integration/consumers/consumer-integration-report.ts`: Separate integration tooling from packaging; isolate
  fixture environments, plan compiler profiles against one artifact, execute real application journeys, and checkpoint
  typed profile/case/command evidence.
- `src/core/execution/checks/check-configuration.ts`, `src/core/execution/checks/check-preparation.ts`,
  `src/core/execution/checks/check-invocation.ts`, `src/core/execution/checks/check-command.ts`,
  `src/core/execution/checks/check-finalization.ts`: Separate declared checks, named preparation requests, environment
  invocation generation, execution, and visible post-check maintenance phases.
- `src/core/toolchains/tool-adapters.ts`: Associate built-in tool verification probes, installation strategies,
  dependencies, and native environment contributions.
- `src/core/execution/checks/work-admission.mts`, `test/integration/tooling/work_queue.test.mts`: Define dynamic work
  queues with failure draining and admission leases. Coverage processing uses a local allocation within its check.
- `src/core/configuration/runtime-parsers.mts`: Share one self-contained TOML/YAML parser runtime across copied
  managed-input helpers.
- `test/core/artifacts/managed_image_import.test.mts`: Serialize managed archive imports and remove operation-owned
  source tags while preserving preexisting tags.
- `src/core/execution/ci/support/ci-operations.mts`: Groups configured target phases by operation and profile, rejecting
  missing or duplicated work.
- `src/core/execution/ci/ci-checks.ts`, `src/core/execution/checks/check-network.mts`: Executes fresh offline and online
  partitions of the same configured CI gate.
- `src/core/execution/ci/ci-images.ts`, `src/core/execution/ci/support/ci-image-transfer.mts`: Requires published,
  input-bound CI images and checks availability for every configured image platform.
- `src/core/execution/ci/support/ci-execution.mts`: Execute the shared target-phase, cancellation and report lifecycle
  for hosted runners, guests and local CI.
- `src/core/execution/ci/support/ci-image-contract.mts`, `test/core/execution/ci/ci_contracts.test.mts`: Require
  immutable published identities for image handoff, rejecting local-only images and unrelated registry repositories.
- `test/core/execution/ci/ci_image_availability.test.mts`: Verify repository-configured image platforms, deduplicated
  manifest queries, and distinct missing-image and registry-access failures without acquisition or preparation.
- `src/core/artifacts/development-locks.ts`: Inspects preparation ownership and guards explicit digest-bound recovery
  against active or uncertain process scopes and container work.
- `src/core/artifacts/image-emulation.ts`: Checks enabled persistent binfmt registration for explicit foreign image
  assembly and offline execution.
- `src/core/execution/checks/check-targets.ts`, `test/core/execution/checks/check_targets.test.mts`: Normalize and
  explain CI target selection consistently for checks, coverage, and required setup.
- `src/cli/checks.ts`, `src/cli/development.ts`: Register gate, CI, environment, and shell interfaces around shared
  execution services.
- `src/core/execution/environments/execution-context.ts`: Carry operation-local environment selections across
  asynchronous work and into child commands without changing the process environment.
- `src/core/artifacts/container-startup.ts`: Validate container ownership and drain bounded startup processes
  independently of profile preparation.
- `src/core/execution/ci/ci-hosting.ts`, `src/core/execution/ci/ci-destinations.ts`: Define supported CI providers,
  canonical Git project identities, destination matching, registry defaults, and strict destination configuration.
- `src/core/execution/ci/ci-workflows.ts`, `src/core/execution/ci/ci-hosted-target.ts`,
  `test/core/execution/ci/ci_hosting.test.mts`, `test/core/execution/ci/ci_hosted_target.test.mts`: Generate
  project-owned GitHub and GitLab workflows from shared target definitions and execute native or verified prepared-image
  targets with retained reports.
- `src/core/artifacts/registry-management.ts`, `test/core/artifacts/gitlab_registry.test.mts`: Separate GHCR and GitLab
  inventory, exact identity revalidation, and explicit deletion from provider-neutral Docker image transport.
- `src/core/execution/ci/ci-job-plan.ts`, `src/core/execution/ci/ci-hosted-jobs.ts`,
  `test/core/execution/ci/ci_hosted_jobs.test.mts`: Share platform preparation and configured operation graphs, bind
  handoffs to exact source snapshots, and reject stale or foreign preparation.
- `src/core/artifacts/registry-management-contract.ts`, `src/core/artifacts/registry-api.ts`,
  `test/core/artifacts/registry_api.test.mts`, `test/core/artifacts/registry_capabilities.test.mts`: Validate
  independent API capabilities and own bounded, cancellable provider requests and complete deletion prevalidation.
- `src/core/execution/ci/ci-validation.ts`, `test/core/execution/ci/ci_validation.test.mts`: Supply local syntax
  validation and explicitly selected GitLab server schema checks without creating pipelines.
- `test/integration/consumers/consumer-ci.ts`: Maintains packaged-CLI CI setup, workflow lint, and native handoff
  integration scenarios alongside installation and language journeys.
- `src/core/execution/ci/support/ci-actions.mts`: Own immutable workflow component pins shared by generation,
  maintenance discovery, derived workflow publication and strict workflow checks.
- `src/core/toolchains/acquisition/network-retry.mts`, `src/core/toolchains/acquisition/network-command.mts`: Share
  bounded, cancellable network acquisition retries, response classification, safe command replay and retained failure
  causes.
- `test/core/toolchains/acquisition/network_retry.test.mts`: Exercise recovery, permanent failures, cancellation, rate
  limits and real acquisition subprocess behavior.
- `src/core/toolchains/acquisition/image-acquisition.mts`: Preserve the active process owner and distinguish unavailable
  registries from missing prepared images during shared registry pulls.
- `src/core/diagnostics/failure-excerpt.ts`: Scans failed logs with bounded memory and preserves source diagnostics
  alongside the final outcome, prioritizing source causes over general warning floods and honoring cancellation;
  app/src/core/execution/checks/check-output.ts removes check protocol records before presentation.
- `src/core/runtime/windows-process.mts`, `src/core/runtime/windows-process-launch.mts`: Supervise Windows commands with
  creation-time job membership, authenticated control-channel ownership, preserved streams, and explicit job-empty
  evidence.
- `test/integration/tooling/windows_process.test.mts`, `test/core/toolchains/native_tool_selection.test.mts`: Verify
  Windows process protocol and native process lifetime, and reject unresolved language tool selections before runner or
  acquisition effects.
- `test/integration/consumers/consumer-integration-java.ts`: Extends Java's maintained consumer journey with
  direct/transitive runtime dependencies, missing-library rejection, and stale-dependency removal, using the starter's
  existing artifact pins. Exercises source-built sibling libraries against stale private cache entries, unchanged
  versions, frozen plugin checksums, and standalone packaged execution.
- `test/core/toolchains/maven/java_sources.test.mts`, `test/core/toolchains/maven/java_reports.test.mts`,
  `test/core/toolchains/maven/java_execution.test.mts`: Verify concurrent-edit protection during Java formatting,
  complete report replacement, failure recovery, and configured runner behavior.

- `src/core/execution`: Plans and runs checks and CI sessions using selected environments and immutable source
  snapshots.

- `src/core/git`: Captures Git content and history for proposed-tree checks, commit policy, and review baselines.
