# CPU budgets and concurrent local CI

Single-root checks, shells, and a local CI rehearsal with one selected target default to all available CPUs. A rehearsal
with multiple targets defaults to four CPUs per job so independent jobs can run together. User preferences in the global
Workbench `config.toml` can override either default for all projects. Git-ignored `workbench/local.toml` overrides the
user preferences for one checkout. Both files accept:

```toml
[execution]
# Optional: override the automatic allocation for each job.
# cpus_per_job = 4
# Optional: reduce local CI concurrency below the automatic CPU-derived maximum.
# max_jobs = 8
```

Clamp the allocation to the coordinator's available CPUs, then divide available CPUs by the job allocation and round
down to determine local CI concurrency. The selected target count and optional `max_jobs` further lower the limit. On a
host exposing 64 CPUs, a standalone check uses 64 workers; a multi-target rehearsal permits up to 16 simultaneous
four-CPU jobs. A two-CPU hosted runner uses two workers. Memory budgeting is currently omitted.

```sh
workbench config get execution.cpus_per_job
workbench config set execution.cpus_per_job 4
workbench config set execution.max_jobs 8
workbench config set execution.max_jobs 1 --scope local
workbench ci --plan
workbench ci --plan --json
```

Inspection exposes the resolved allocation and concurrency without execution. Tool worker counts are budgets rather than
hard CPU confinement. Serial phases, small source sets, and dependencies can leave workers idle. No tool is required to
invent parallel work.

## Check groups

Check gates share the same user preferences. Independent roots default to four CPUs per group, while the project root
normally has the full standalone allocation and finishes before descendants. Explicit `check_order` declarations can
allow selected roots to overlap after setup; see [check ordering](checks.md).

When the project root can overlap other roots, automatic allocation reserves up to one quarter of the available CPUs
for their complete worker slots. For example, a 32-CPU gate assigns 24 CPUs to the root and four to each example, allowing
two examples alongside the root. A 16-CPU gate assigns 12 plus four. On eight CPUs, the root retains all eight and examples
wait. Once the root finishes, more examples can run within the same total budget and job limit. An explicit per-job cap
still applies; `max_jobs = 1` preserves serial execution with the root's standalone allocation.

Budgets stay fixed for each admitted session. Inspection, execution, and successful-check evidence use the same resolved
ordering and allocations. Selecting one root remains self-contained, including its setup. Cache-hit security refreshes
derive their own allocations from the checks that actually run.

## Language controls

Workbench supplies the assigned CPU limit as `WORKBENCH_CPU_BUDGET` and the tools' worker controls. It reserves
`WORKBENCH_CPUS` for an explicit caller request for CPUs per job. Entering an automatic development shell therefore does
not create a per-job override: nested check groups can share the shell's budget. Nested checks, shells, compatibility
runners, Dev Containers, and managed environments cannot allocate more CPUs in aggregate than their inherited budget,
even when a caller requests a larger value.

Normal commands resolve user/checkout preferences; CI supplies each worker's assigned limit. `WORKBENCH_CPUS` and
`WORKBENCH_MAX_JOBS` override preferences for an invocation within that limit. Direct tools use the smaller of the
assigned limit and an explicit request. Unset preferences use the automatic policy above. Tracked project configuration
rejects machine execution settings. Counts outside the positive integer range are errors.

| Toolchain                         | Controls                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| C/C++                             | CMake build workers, CTest workers, vcpkg workers; Linux LLD and GCC LTO workers                 |
| Rust                              | Cargo build jobs, nextest test workers, libtest threads                                          |
| Go                                | Go runtime parallelism and package build/test parallelism                                        |
| Python                            | pytest-xdist workers, Ruff/Rayon threads, uv build/install workers                               |
| TypeScript, JavaScript, and React | Vitest workers, Node worker pool, esbuild's Go runtime where used, package-manager build workers |
| Java                              | Maven parallelism, JVM active processor count, SpotBugs JVM allocation, fixed JUnit worker pool  |
| Nix/Guix                          | One concurrent derivation per job, using the assigned build cores                                |

Single-threaded tools retain their native execution model. Copied example test configurations also work outside
Workbench: Vitest uses its ordinary default when no allocation is supplied; pytest-xdist uses its automatic worker
selection. Direct CMake builds retain their native parallel controls.

## Isolation and caches

Local CI freezes one snapshot of the proposed checkout, preserving its staged, unstaged, and untracked inputs without
changing the source index. Each selected target gets an independent snapshot copy, checkout identity, build/dependency
paths, HOME for native container execution, logs, and reports. Native/compatibility targets use the common pinned Ubuntu
image; managed targets use their configured launchers. The coordinator builds that common image once.

The pool bounds preparation, execution, and cleanup together. Create a target's workspace when admitting its job and
release its owned containers and workspace before admitting the next job in that slot. A failing target does not cancel
independent targets. One signal lifecycle covers source preparation, image acquisition, execution, and cleanup. On an
orderly interruption, stop admitting work and let active mutations finish before cleanup. Per-target logs and aggregate
results remain in the reported temporary report directory. Uncertain cleanup preserves the affected resources and
recovery lock. Validate the complete private worker request before executing its commands.

Verified tool and package-manager installations use exclusive installation locks. Waiters reuse the accepted result;
failed writers remove only their private staging and release their own lock. Lock waits are bounded, and abandoned locks
require explicit recovery. Package managers retain their own content-cache locking, and content-addressed download files
are verified and accepted atomically. Download caches are retained when disposable job outputs are cleaned. If
installation and lock release both fail, retain both causes in the diagnostic rather than masking the installation
failure.

Hosted CI uses the same language worker controls on each runner. Its matrix scheduling remains GitHub's responsibility.
Local rehearsal does not establish hosted permissions, registry publication, or other-platform behavior.

## Selecting a local rehearsal

The default rehearsal selects every configured Linux x64 target; explicit `--path` or `--target` narrows an iterative
run. Every hosted run retains the complete configured gate. Prepared profiles share their images with development; other
native runs use the common pinned Ubuntu base and verified acquisition caches.
