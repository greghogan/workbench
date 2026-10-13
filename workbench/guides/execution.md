# CPU budgets and concurrent local CI

Project-owned `workbench/config.toml` controls worker allocation for all registered language roots and examples:

```toml
[execution]
cpus_per_job = 4
# Optional: reduce local CI concurrency below the automatic CPU-derived maximum.
# max_jobs = 8
```

The default is four CPUs per job. Clamp that number to the coordinator's available CPUs, then divide available CPUs by
the job allocation and round down to determine local CI concurrency. The selected target count and optional `max_jobs`
further lower the limit. On a host exposing 64 CPUs, the default permits 16 simultaneous four-CPU jobs. A two-CPU hosted
runner uses two workers. Memory budgeting is currently omitted.

```sh
workbench config get execution.cpus_per_job
workbench config set execution.cpus_per_job 4
workbench ci --plan
workbench ci --plan --json
```

Inspection exposes the resolved allocation and concurrency without execution. CPU worker budgets and benchd admission
are distinct: ordinary holds coordinate substantial work with benchmarks; they do not impose per-job CPU or RAM quotas.
Tool worker counts are budgets rather than hard CPU confinement. Serial phases, small source sets, and dependencies can
leave workers idle. No tool is required to invent parallel work.

## Language controls

Workbench supplies the validated allocation as `WORKBENCH_CPUS` and the tools' worker controls. Nested checks, shells,
compatibility runners, Dev Containers, and managed environments retain the job allocation. Normal commands resolve the
project configuration; CI sets an explicit allocation from the coordinator. Counts outside the positive integer range
are errors.

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
