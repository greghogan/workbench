# Checks and environments

Resolve configured work, select tools and environments, and coordinate isolated CI.

| Paths                                                                                             | Responsibility                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tool-profiles.ts`                                                                            | Resolves named compiler/runtime selections and the roots and platforms where they apply.                                                                                                          |
| `src/ci.ts`                                                                                       | derives CI coverage and installation versions from configured language roots and native pins.                                                                                                     |
| `scripts/ci-plan-contract.mjs`, `scripts/ci-plan-contract.mts`                                    | validate and type hosted matrix output and define intentional job skips.                                                                                                                          |
| `scripts/ci-plan.mts`, `scripts/ci-plan.mjs`                                                      | validates the complete configured hosted matrix and presents its coverage.                                                                                                                        |
| `scripts/ci-status.mts`, `scripts/ci-status.mjs`                                                  | requires validation and every selected hosted job to succeed.                                                                                                                                     |
| `src/ci-targets.ts`                                                                               | catalogs configured targets and groups shared hosted setup without dropping roots.                                                                                                                |
| `src/ci-runtime.ts`                                                                               | selects verified compatibility runtimes independently of development pins.                                                                                                                        |
| `src/local-ci.ts`                                                                                 | selects Linux x64 targets and coordinates isolated jobs and combined rehearsal reports.                                                                                                           |
| `src/local-ci-workers.ts`                                                                         | bounds concurrent worker admission and drains active jobs before interruption.                                                                                                                    |
| `src/ci-lifecycle.ts`                                                                             | owns interruption across preparation, admitted commands, and cleanup.                                                                                                                             |
| `src/execution-resources.ts`                                                                      | resolves configured CPU budgets and local CI concurrency.                                                                                                                                         |
| `src/cache-lock.ts`                                                                               | serializes cache writers, protects active check logs during pruning, and preserves uncertain locks.                                                                                               |
| `scripts/cache-ownership.mts`, `scripts/cache-ownership.mjs`                                      | restores shared cache ownership without following links or failing on removed entries.                                                                                                            |
| `scripts/cpu-budget.mjs`, `scripts/cpu-budget.mts`                                                | supply language worker controls from one job allocation.                                                                                                                                          |
| `scripts/ci-worker-request.mjs`, `scripts/ci-worker-request.mts`                                  | validate and type private worker requests.                                                                                                                                                        |
| `src/ci-workspace.ts`                                                                             | owns snapshot isolation, workspace locking, disposable resources, and cleanup recovery.                                                                                                           |
| `src/compilers.ts`                                                                                | validates C/C++ standards, compiler families, support minima, and compiler selections.                                                                                                            |
| `src/environments.ts`                                                                             | owns environment names, local execution preferences, and active-shell boundaries.                                                                                                                 |
| `src/builds.ts`                                                                                   | owns build identities, generation validation, storage paths, native tool controls, locking, and scoped cleanup.                                                                                   |
| `src/build-cache.ts`                                                                              | groups owned checkout caches and the virtual Tools project, then selects and confirms recursive cleanup.                                                                                          |
| `src/cache-prune-selection.ts`                                                                    | derives the pure selection model used by the prune menu, returned deletion set, and confirmation totals.                                                                                          |
| `src/prepared-images.ts`                                                                          | coordinates locked revalidation and explicit local or GHCR image deletion.                                                                                                                        |
| `src/image-contract.ts`                                                                           | owns prepared image identities, profile locks, protection reasons, and backend-specific report types.                                                                                             |
| `src/local-images.ts`                                                                             | records local image ownership and inventories selected Docker references and container protection.                                                                                                |
| `src/registry-images.ts`, `src/image-process.ts`                                                  | inspect OCI manifests and GHCR versions through bounded metadata queries.                                                                                                                         |
| `src/image-input-validation.ts`                                                                   | checks declared managed dependency files against selected profile inputs.                                                                                                                         |
| `src/windows-host.ts`                                                                             | normalizes Windows Git installations and platform paths for native check environments.                                                                                                            |
| `scripts/split-prepared-inputs.mts`, `scripts/split-prepared-inputs.mjs`                          | partitions prepared native inputs into tool and dependency image layers.                                                                                                                          |
| `src/tool-cache.ts`                                                                               | inventories shared native, Rustup, and uv installations, protects selected toolsets, and delegates manager-owned removal.                                                                         |
| `src/tool-references.ts`                                                                          | records tool requirements with cached results and refreshes their references automatically during pruning.                                                                                        |
| `src/tool-requirements.ts`                                                                        | normalizes, validates, and matches shared tool identities for active commands and retained results.                                                                                               |
| `src/tool-cache-lock.ts`, `src/cache-size.ts`                                                     | coordinate shared-tool maintenance with build admission and collect approximate cache sizes without following links.                                                                              |
| `src/shell.ts`                                                                                    | opens the selected development shell or runs a command in it.                                                                                                                                     |
| `src/shell-session.ts`                                                                            | validates typed session requests, selects the execution shell, and owns session variables, private launchers, child signals, and cleanup.                                                         |
| `src/checks.ts`                                                                                   | runs portable configured check roles and selected native, Guix, Nix, or Dev Container environments.                                                                                               |
| `src/check-gates.ts`                                                                              | Coordinates commit, online, and combined local gates, including the optional connectivity probe.                                                                                                  |
| `src/check-plan.ts`                                                                               | selects stages, scoped roots, setup sessions, and coverage variants.                                                                                                                              |
| `src/check-cache.ts`, `src/check-inputs.ts`, `src/check-source-policy.ts`                         | classifies code inputs, fingerprints source/tool/environment evidence, and refreshes security checks during local reuse.                                                                          |
| `src/check-environment.ts`                                                                        | Constructs native tool environments from declared inputs, selected SDKs and root-specific budgets, and identifies external configuration inputs.                                                  |
| `src/check-runner.ts`, `src/check-progress.ts`                                                    | schedules independent check groups within CPU and job budgets, coordinates worker cancellation, and retains timed completions, redraws active tasks, and coordinates authenticated check results. |
| `src/check-cancellation.ts`                                                                       | cancels checks and development commands, escalating process-tree shutdown while retaining ownership until completion.                                                                             |
| `.github/workflows/checks.yml`                                                                    | runs four native platform jobs and project-wide prepared Nix/Guix environments.                                                                                                                   |
| `.github/actionlint.yaml`                                                                         | lists verified hosted-runner labels absent from the pinned validator's built-in list.                                                                                                             |
| `scripts/ci-run.mts`, `scripts/ci-run.mjs`                                                        | executes shared native, compatibility, managed-environment, and standalone release phases.                                                                                                        |
| `scripts/ci-contract.mjs`, `scripts/ci-contract.mts`                                              | defines target phases and execution selections; `scripts/ci-contract.mts` defines the target variants and phase types.                                                                            |
| `scripts/ci-layout.mjs`, `scripts/ci-layout.mts`                                                  | defines cache locations and forwarded CI variables; `scripts/ci-layout.mts` declares its interface.                                                                                               |
| `scripts/ci-results.mjs`, `scripts/ci-results.mts`                                                | validates and persists combined target/infrastructure outcomes and collects attempt evidence; `scripts/ci-results.mts` declares the result protocol.                                              |
| `scripts/ci-reports.mjs`, `scripts/ci-reports.mts`                                                | collects only reports produced by the current target; `scripts/ci-reports.mts` declares its shared TypeScript interface.                                                                          |
| `scripts/ci-linux`                                                                                | contains the authenticated Ubuntu bootstrap image and local target/report coordinator.                                                                                                            |
| `src/devcontainers.ts`, `.devcontainer`                                                           | adapts the locked Dev Container CLI with private startup scratch directories and cleanup; `.devcontainer` defines the workspace and its OS prerequisites.                                         |
| `src/ci-cache-inspection.ts`, `scripts/ci-cache.mts`, `scripts/ci-cache.mjs`                      | batches read-only installation and source inspection, then derives hosted retention paths and cache identities.                                                                                   |
| `scripts/ci-guix-bootstrap.mts`, `scripts/ci-guix-bootstrap.mjs`, `scripts/ci-guix-bootstrap.scm` | retain and import signed pinned Guix runtime closures on disposable hosted runners.                                                                                                               |
| `src/profile-schema.ts`                                                                           | validates named development and release profile declarations.                                                                                                                                     |
| `src/development.ts`                                                                              | lists profiles and persists local development selection.                                                                                                                                          |
| `src/development-images.ts`                                                                       | presents prepared-image status and coordinates separately selected preparation and publication through the shared operation runner.                                                               |
| `src/release-profiles.ts`                                                                         | prepares configured artifacts, verifies relocated copies, and records provenance.                                                                                                                 |
| `scripts/ci-native-prerequisites.mts`, `scripts/ci-native-prerequisites.mjs`                      | prepares hosted SDK dependencies for native Ruby and PHP runtimes.                                                                                                                                |
| `src/compatibility-checks.ts`                                                                     | selects and describes project-owned compatibility commands from the selected language definition.                                                                                                 |
| `scripts/ci-cache-metrics.mts`, `scripts/ci-cache-metrics.mjs`                                    | records cache footprint and elapsed verification-window evidence.                                                                                                                                 |
| `scripts/ci-publish.mts`, `scripts/ci-publish.mjs`                                                | verifies prepared image receipts, publishes selected CI tags, and checks registry pulls.                                                                                                          |
| `.github/workflows/publication.yml`                                                               | separately selects Nix/Guix registry verification with package write authority.                                                                                                                   |
| `src/offline-profiles.ts`                                                                         | prepares, verifies, and explicitly publishes offline development images and tracks input identities in user-cache receipts.                                                                       |
| `scripts/ci-image.mjs`, `scripts/ci-image.mts`                                                    | share the authenticated native CI image recipe and platform checks.                                                                                                                               |
| `scripts/ci-hosted.mts`, `scripts/ci-hosted.mjs`                                                  | Runs the exact configured targets on a hosted native platform or in its prepared environment.                                                                                                     |
| `scripts/prepare-development.mts`, `scripts/prepare-development.mjs`                              | Prepares toolchains, dependency archives and pnpm policy metadata, and verifies fresh offline builds.                                                                                             |

- `src/managed-inputs.ts`, `src/managed-input-environment.ts`, `src/managed-registry.ts`: Validate realized dependency
  sources and provide local acquisition interfaces to language package managers.
- `scripts/managed-check-inputs.mts`, `scripts/managed-check-inputs.mjs`, `scripts/managed-input-recipes.mts`,
  `scripts/managed-input-recipes.mjs`, `scripts/refresh-managed-inputs.mts`, `scripts/refresh-managed-inputs.mjs`:
  Derive standalone Nix/Guix source packages and refresh pinned proof metadata.
- `src/managed-image.ts`, `scripts/prepare-managed-development.mts`, `scripts/prepare-managed-development.mjs`,
  `scripts/prepare-host-managed-development.mts`, `scripts/prepare-host-managed-development.mjs`,
  `scripts/prepare-nix-profiles.mts`, `scripts/prepare-nix-profiles.mjs`: Assemble managed images in an installed
  manager's host store or a Docker fallback, retaining separate per-root profiles through one dependency graph per
  builder.
- `src/container-references.ts`: Validates explicit OCI repository locations and tagged image references.
- `src/managed-profiles.ts`: Registers persistent host development profiles, refreshes owned Guix environment roots
  before checks, and releases registrations during dependency pruning.
- `scripts/pack-guix-image.mts`, `scripts/pack-guix-image.mjs`, `.devcontainer/guix/image.json`: Validate and apply
  declarative Guix image layout, keeping pack contents independent of orchestration and cache settings.
- `src/image-finalization.ts`: Finalizes imported image metadata and account files without rebuilding or shared BuildKit
  cache.
- `src/buildkit.ts`, `scripts/container-tools/buildkit-image.txt`: Own pinned, project-scoped Docker builders,
  persistent BuildKit state, private client configuration, and verified cleanup.
- `src/builder-cache.ts`: Inventories Docker builder stores and revalidates ownership and active use before explicit
  grouped volume removal.
- `scripts/check-workflows.mts`, `scripts/check-workflows.mjs`: Validates workflow files and project runner
  configuration without requiring Git metadata.

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
  cancellation, and recover only proven abandoned process locks before rechecking evidence.
- `src/check-order.ts`, `src/check-resources.ts`: Validate explicit ordering, derive selected session dependencies, and
  share fixed CPU allocations across scheduling, inspection, and evidence fingerprints.
- `src/check-control.ts`: Accepts only a session's private, ordered wrapper records as readiness and completion signals.
- `scripts/managed-process.mts`, `scripts/managed-process.mjs`, `src/command-availability.ts`: Own preparation child
  lifetimes, bounded capture, cancellation, exhaustive cleanup, and command discovery.
- `scripts/managed-contract.mjs`, `scripts/managed-contract.mts`: Defines builder cache identities, volume layouts, and
  validated preparation plans.
- `scripts/managed-source-contract.mjs`, `scripts/managed-source-contract.mts`, `scripts/managed-files.mts`,
  `scripts/managed-files.mjs`: Validate source declarations and atomically replace generated metadata after acquisition
  and generation finish.
- `scripts/verify-managed-preparation.mts`, `scripts/verify-managed-preparation.mjs`: Explicitly verifies two tiny
  host-managed profiles in a real offline Docker image and releases its temporary profile roots and image tags.

- `scripts/prepare-guix-profiles.mts`, `scripts/prepare-guix-profiles.mjs`: Realizes independent Guix channel groups,
  retains per-root profiles and matching runtimes, and passes only realized store paths to image assembly.

- `src/check-output.ts`: Captures command output and presents grouped summaries from structured details while logs
  remain owned.
- `src/check-report.ts`, `scripts/check-detail-data.mts`, `scripts/check-detail-data.mjs`: Define validated check
  details and versioned execution reports, including bounded diagnostics and atomic publication.
- `src/offline-verification.ts`: Separates source-specific verification proofs from immutable image identity, including
  external distribution bytes.
- `scripts/pnpm-metadata.mts`, `scripts/pnpm-metadata.mjs`: Retains locked package policy metadata through a disposable
  importer and the verified package manager.
