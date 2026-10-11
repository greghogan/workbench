# Hosted CI and local rehearsal

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

The [GitHub workflow](../../.github/workflows/checks.yml) reads `workbench checks matrix` to build its matrix from
configuration:

```toml
# workbench/config.toml
[checks]
environment = "native"
# nix_docker_image = "nixos/nix@sha256:..."  # Use a real, reviewed digest for nix-docker.

[ci]
operating_systems = ["linux", "macos", "windows"]
architectures = {linux = ["x64", "arm64"], macos = ["arm64"], windows = ["x64"]}
environments = ["guix", "nix-docker", "devcontainer"]
```

CI supplies an explicit environment to each job, independently of local defaults and preferences. Both Guix and Nix can
be selected together; `environments = []` selects native jobs only. Omit `[ci]` when the project does not use the matrix
generator. CI needs at least one operating system and registered language root. There is no separate CI language list:

```toml
# workbench/projects.toml
[[language_root]]
language = "typescript"
path = "web"

[[language_root]]
language = "python"
path = "worker"
ci_environments = []
ci_versions = ["3.11.17", "3.12.15", "3.13.16", "3.14.8", "3.15.0"]
```

Roots default to native jobs on all selected operating systems and architectures. Optional `ci_platforms` narrows a root
to configured targets such as `["linux-x64"]`. `ci_compatibility = false` omits that root's additional runtime and
compiler compatibility jobs; it cannot be combined with `ci_versions`. These options scope examples without changing the
underlying language's support declarations. Languages sharing a root must agree on all CI selections. `ci.architectures`
selects native architectures per OS; when omitted, Linux/Windows use x64 and macOS uses arm64. Managed environments
remain independent Linux targets. Roots inherit the CI environment list; optional `ci_environments` narrows it, with
`[]` disabling managed jobs for that root. Languages sharing a root must agree on this selection and produce one job per
target. Each root's `[[check]]` commands and authoritative native tool pins supply its checks and installations. Guix
requires channels and a manifest; Nix requires a flake and lock. Dev Containers require the root descriptor. Missing
configuration fails planning. Managed jobs use Linux regardless of the native OS list. `nix-docker` needs Docker and the
configured image digest; direct `nix` requires an installed Nix bootstrap on the runner. The supplied workflow
bootstraps Guix on Ubuntu 24.04, which supplies its signed bootstrap package, and uses the Docker already provided by
GitHub for Nix. Other Linux jobs use Ubuntu 26.04; project channel and flake pins are independent.

Workbench selects Linux on x64 and arm64, Windows on x64, and macOS on arm64. It registers its own TypeScript root and
all ten language references, and selects Guix, Nix, and Dev Containers for the references. The CLI root selects native
and Dev Container jobs. The Dev Container job provisions one workspace and runs only the roots selecting that
environment. The workflow also tests Node, Java, Ruby, PHP, Python, Rust, and Go minima derived from their native
manifests, independently of development pins. TypeScript, JavaScript, Java, Ruby, PHP, Python, and Go roots can add
exact runtime pins with `ci_versions` in `workbench/projects.toml`. Compatibility jobs run on Linux; the matrix removes
targets already covered by native jobs or an identical minimum. Python selections must cover every minor line from the
minimum through the newest selected or development interpreter. The Python reference covers 3.11 through 3.15 while
retaining the exact 3.11.17 floor. Compatibility jobs use pnpm, Maven/JUnit, Bundler/Minitest, Composer/PHPUnit,
uv/pytest, Cargo, and Go tests; consuming projects adapt these commands to their own test runners.

Native CI jobs also prepare each root's configured release artifacts, exercise them outside the source checkout, and
retain them as workflow artifacts. Their tar archives preserve executable permissions, hidden files, and skill links.
This verifies local release packaging; release publication remains a separate operation.

Release-line coverage follows each language's maintenance model: Python's maintained minor lines, Node's maintained LTS
lines and supported Current line, Java's declared maintained LTS and Current releases, Go's two maintained lines, and
Ruby's and PHP's maintained release lines. Rust tests current stable and its declared minimum. C/C++ retain their
selected language standards while testing declared compiler families and maintained release lines; the references use
Clang for development and cover Clang's declared minimum and GCC's maintained lines on Linux. GCC compatibility jobs run
on both x64 and arm64 runners, using the same version selections and test commands. Compiler compatibility jobs install
LLVM plus the selected compiler, then execute ordinary and sanitizer tests.

Windows checks require Git Bash and enabled directory symlinks. Use `node bin/workbench.mjs` or the `workbench.cmd`
launcher from a native Windows terminal. GNU Make helpers are optional POSIX conveniences; their tests run on Linux and
macOS. Managed environment jobs run on Linux. The CLI integration suite runs on every selected native OS.

Ordinary pushes and pull requests select roots from changed paths and their shared dependencies, then run each selected
root's complete configured matrix. ADR-only changes run validation and documentation checks without example jobs.
Unknown ownership or unavailable history selects every root. Jobs keep checking other selected roots after a root fails.
Manual full runs, tags, and release verification run the complete matrix. The stable `Checks passed` status requires
validation and all selected jobs to succeed; intentionally empty groups are skipped. Roots share native jobs by
platform, compiler compatibility jobs by compiler/version/architecture, and managed jobs by environment. Each root still
uses its own declared pins and complete checks, including release verification.

CI caches small installed tools, filtered LLVM installations, dependency downloads, incremental builds, and verified
compiled GCC installations. Selected Rust stable, MSRV, and Miri toolchains use an isolated CI rustup home; only their
selected versions and bootstrap proxies are retained. Dev Container caches include selected guest tool versions,
filtered LLVM, vcpkg, and managed Python installations. Every job records elapsed restore/setup/check time and retained
uncompressed cache bytes as an artifact and summary. GCC is compiled once per version and architecture and reused for
both C and C++; its installation is saved after tool verification so a later project-test failure does not discard the
expensive compiler build. Guix caches authenticated source history; roots share its bootstrap and store within one job.
Nix roots similarly share a job-local store and use upstream binary substitutes. Lockfiles, tool pins, platform, runtime
selection, and the compiler installer determine cache keys. LLVM caches contain the selected language components and
private runtime, with separate keys covering the source, filter, authentication policy, trust material, and installer.
Restored filtered contents are verified before reuse, and newly verified installations are saved before project checks.
Cache hits still run configured checks; caches do not store test results as evidence of a passing run. Package download
stores have separate keys from installed dependencies and compiled outputs. Installer changes and runtime patch
selections invalidate the compiled-output cache without invalidating the download cache. Compatibility jobs include only
the native artifacts required by their execution phases; package managers still validate reused downloads through their
lockfiles and integrity checks.

The workflow does not raise GitHub's default 10 GB cache limit. Complete LLVM distributions, discarded source archives,
and whole Nix/Guix stores are excluded from GitHub caches. Retained LLVM components compete with other caches for this
allowance. New pins and cache misses require fresh setup. Standard GitHub-hosted runners are free for public
repositories; private repositories and larger runners have their applicable billing rules. Cache storage is a separate
allowance. See
[GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Release
artifacts and coverage reports use a 14-day retention period in the supplied workflow. Cache choices still affect
feedback time, transfers, eviction, and runner disk use.

Failures appear as GitHub checks and through the repository's configured GitHub notifications. Hosted verification
remains pending; a local Linux pass does not establish another platform's results. Branch protection, spending budgets,
and notification preferences are repository settings.

To reproduce an environment job locally when that environment is installed:

```sh
workbench checks run --path examples/languages/python --environment guix
workbench checks run --path examples/languages/rust --environment nix
workbench checks run --path examples/languages/typescript --environment nix-docker
```

`workbench language check --all` verifies bundled references using the local selection; `--environment native`
explicitly uses native pins. Host, Guix, and Nix selections are independent; updating one does not update the others.

### Selecting affected CI roots

The planning job calls `workbench checks matrix --grouped --affected --base REVISION --head REVISION`. Pushes compare
against the previous pushed revision; pull requests add `--merge-base` and compare the base and head commits. Both sides
of renames, deletions, type changes, and dependencies from both revisions participate. Missing history, new branches,
invalid historical declarations, and uncertain ownership fall back to every root. Checkout uses full history; the
selector never fetches or executes historical code. Selection happens before job grouping and cache/tool installation.
Fallback reports identify the failing operation and whether history, declarations, changed paths, or checkout identity
prevented comparison. Unexpected implementation errors fail planning instead of silently scheduling the full matrix.

Use `workbench checks matrix --grouped --full` for initial verification and release checks. The manual workflow's
full-run option defaults to true; disable it and supply `base` for a manual affected run. CI prints selected/excluded
roots, revisions, and reasons in the job summary. It does not skip the whole workflow through GitHub path filters, so a
documentation-only change still receives an aggregate status.

Local rehearsal uses the same resolver:

```sh
workbench ci --plan --affected --base main
workbench ci --affected --base main
workbench ci --plan --affected --base main --head HEAD --merge-base
make ci BASE=main
```

Without `--head`, local selection includes staged, unstaged, and nonignored untracked files. With `--head`, it compares
only committed inputs. `--plan --json` includes grouped selection reasons, changed-file counts, and complete target
commands. Add `--explain-files` to include the complete changed-path list and matching files for each reason. Normal
hosted planning sends compact explanations; explanation size never expands the selected matrix. An empty affected local
selection validates the project and acquires no example tools, dependency caches, containers, or job workspaces. The
normal local rehearsal remains a full run. Commit hooks always check the complete proposed tree.

Selected language directories and script arguments beginning with `{workbench}/` are automatic shared inputs. A local
language replacement ignores its shared definition. Unknown shared inputs, including CLI, installer, bundle, workflow,
and global configuration changes, select all roots. Declare additional shared input files or directories explicitly:

```toml
[[ci.dependencies]]
paths = [ "shared/schemas", "shared/python-support.py" ]
roots = [ "examples/languages/python" ]
```

Paths are repository-relative files or directory prefixes, with component boundaries; they are not glob expressions.
These declarations add dependencies and cannot remove root ownership or the conservative fallback. Every target root
must be registered. Workbench's own CI dependency configuration is project-owned; consumers declare their own inputs.
Dependencies on another root propagate through its shared inputs, including dependencies retained in the previous
revision. Explanations retain each applicable immediate dependency cause, including for roots already selected by
another input; cycles terminate conservatively. Explicit dependencies also apply to documentation inputs used by a
build. Shared language replacement and provenance rules remain unchanged. See
[ADR-10](../../workbench/decisions/ADR-10.md) for CI policy.

## Local rehearsal

`workbench ci` or `make ci` rehearses **all configured Linux x64 targets** by default: native CI gates, compatibility
versions, and managed environments. Successful native gates also prepare and verify standalone release artifacts;
`--no-release` omits this step. Inspect the targets with `workbench ci --plan` or `--plan --json`; select one root with
`--path`, or any subset using `--target ID...`. Make accepts `ROOT=path` or `TARGETS="ID ID"`. Unknown targets and empty
explicit target selections fail. An empty affected-root selection validates without launching example jobs. Framework
roots retain their configured Linux x64 environment coverage.

Local rehearsal requires a native Linux x64 host, Docker, and the launchers for selected managed environments: Guix for
Guix targets, Nix for direct Nix targets, Docker for Nix Docker, and the locked Dev Container CLI installed by Workbench
for Dev Container targets. Unavailable launchers fail their selected targets; they are not silently skipped. Native
gates and compatibility tests run in a pinned Ubuntu 26.04 image with an authenticated Node bootstrap. Managed targets
use the same configured launchers and check plans as hosted CI. The rehearsal never selects emulation. Container builds
and runs use host networking, including managed launchers through a temporary Docker client adapter. This permits
network acquisition without relying on the Docker bridge's DNS configuration.

The initial Node bootstrap verifies its signed SHA-256 catalog and streams extraction into private staging before
activation. Its limits are 128 MiB compressed, 512 MiB decompressed, 256 MiB per file, 64 KiB per metadata entry, and
20,000 archive entries. The per-file allowance accommodates the pinned upstream Node executable; checks still reject
oversized entries, unsafe paths, sparse files, and escaping links.

Each run snapshots tracked files and nonignored new files, including pending edits and deletions, into a private
workspace under `/tmp`. Integrated Workbench repositories receive independent snapshots as well. The source checkout and
its Git index are preserved. A stable workspace path and the Workbench XDG cache reuse verified tool installations,
dependency downloads, and isolated incremental builds. Compatibility versions receive separate build identities. uv owns
its isolated `uv-python/python` store, keeping its legacy directory migration away from Workbench native toolchains. The
image recipe has a stable content tag, allowing Docker layer reuse. The run does not mount the developer's home or
credentials. Cargo and rustup use dedicated directories inside the persistent rehearsal cache.

Disposable workspaces and image contexts are removed after success or failure; an active workspace is never replaced.
Each Dev Container startup also owns and cleans a private temporary directory, preventing upstream scratch-file races
between concurrent jobs while retaining shared dependency caches. Reports, source tree digests (including integrated
repositories), the selected plan, per-target outcomes, and verified release packages remain in the printed
`/tmp/workbench-ci-reports-*/reports` directory for inspection. Failures do not cancel independent selected targets.
`results.json` contains `version`, `targets`, and `errors`: target outcomes are separate from infrastructure failures,
including cleanup failures. The terminal summary and exit status use this combined result after cleanup. Guest results
are accepted only when their target IDs exactly match the selection without duplicates. Each target retains only reports
created or updated during its execution, excluding unchanged baselines and earlier targets' outputs. Failed targets'
reports can be partial; use the recorded target outcome. Delete a report directory after reviewing it. Persistent tool
caches and Docker layers follow their normal cleanup commands. Local rehearsal cannot establish GitHub permissions,
OIDC, registry authorization/publication, or other native platforms; those require hosted checks. Rehearsal does not
publish or change environment pins.

A forced process kill can leave the private workspace and its `active` directory behind. Subsequent runs preserve them
and report that recovery is needed. Confirm that the previous run and its containers have stopped before moving or
removing that abandoned workspace and lock; retain reports needed for diagnosis. A cleanup failure also retains the
workspace lock when resource ownership remains uncertain.

CPU worker allocation and local rehearsal concurrency are documented in
[CPU budgets and concurrent local CI](../../workbench/guides/execution.md).

## Explicit registry verification

The separate [publication workflow](../../.github/workflows/publication.yml) prepares and verifies the Go example's Nix
and Guix Docker profiles, publishes unique CI tags to GitHub Container Registry, removes the local image, then pulls by
registry digest and verifies image identity and offline behavior. It preserves release receipts and publication
evidence. It does not create release records, tags, or deployments. Ordinary checks have read-only permissions and never
publish. The selected workflow grants repository/action reads and package writes, and requires a successful Checks run
for the exact source revision. Publication branches reuse that verified revision without launching its matrix again.

Use its manual GitHub Actions invocation after the workflow is present on the default branch. Before this repository's
initial commit, an intentionally selected `ci/publication-verification-*` branch also triggers this workflow; other
branches do not. These verification tags remain available for inspection and can be removed explicitly through GitHub
Packages. Registry permissions must be tested on GitHub; a local rehearsal cannot establish them. See
[GitHub's container publication documentation](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
