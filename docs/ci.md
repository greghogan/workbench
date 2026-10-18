# Continuous integration

Workbench resolves CI coverage from `workbench/config.toml`, registered language roots in `workbench/projects.toml`, and
their commands. `workbench pre-commit` runs the commit gate; `workbench check matrix` prints CI coverage. Use `--grouped`
for hosted jobs or `--targets` for exact roots, tool selections, phases, and commands.

The provided hosted workflows use GitHub Actions and GHCR. The provider-independent policy is defined in
[ADR-Y](../workbench/decisions/ADR-0Y.md).

Use `workbench ci` for the complete configured Linux x64 rehearsal, including CI-stage advisories, tool profiles,
managed images, and release verification. A passing commit gate or prepared image's offline verification does not
establish that this complete CI gate passes.

Run `workbench pre-push` for the separate online checks, including dependency advisories. It uses fresh results and does
not repeat the offline test gate. CI includes these checks automatically; the complete Linux rehearsal remains
`workbench ci`.

## Reference coverage

The reference workflow runs all language and framework examples on Linux x64, Linux ARM64, macOS ARM64, and Windows x64.
Each native platform job includes Workbench's supported Node profiles. Linux also exercises the selected GCC profile;
Clang remains the default and LLVM supplies formatting and analysis in both cases. Examples otherwise use their selected
development release and static minimum API targets. Nix and Guix each run Workbench and every example in a prepared
Linux x64 environment.

Two additional native Linux jobs prepare the explicit Rust musl profiles, one on x64 and one on ARM64. They run target
tests and verify each static artifact in offline Ubuntu and Alpine containers. The same
`workbench release prepare rust-linux-ARCH-musl` command rehearses this check locally on its matching architecture.

Every push, pull request, and manual run checks all configured roots. There are no changed-path filters. Coverage
replaces the ordinary suite only where configured, and reports its difference from the recorded summary. Native release
artifacts are prepared and exercised outside their source checkout. Independent targets continue after a failure.

Consumers own their copied workflow and may select fewer platforms or one builder. Native, Nix, and Guix remain separate
tool authorities. Missing definitions or unavailable tools fail; Workbench does not silently choose another builder.

Verify collection adoption and reconciliation in independent consuming repositories, including edited records and
retained originals. Verify executable acquisition and launcher selection separately from source-checkout execution.

## Runtime and compiler profiles

Native pins remain the default. Named tool profiles select alternate versions or compiler families for registered roots:

```toml
[[toolchains.profiles]]
name = "node-22"
paths = ["."]
tools.node = "22.23.3"

[[toolchains.profiles]]
name = "gcc"
paths = ["c", "cpp"]
compiler = "gcc"
platforms = ["linux-x64", "linux-arm64"]

[ci]
operating_systems = ["linux", "macos", "windows"]
toolchains = ["node-22", "gcc"]
environments = ["nix", "guix"]

[ci.architectures]
linux = ["x64", "arm64"]
macos = ["arm64"]
windows = ["x64"]
```

Use the same selection locally:

```sh
workbench tools profiles
workbench tools install --toolchain node-22
workbench shell --path . --toolchain node-22
workbench check --toolchain gcc
```

Profiles select complete roots, with exact tool versions where provided. Compiler families use the root's compiler pin
unless overridden in the profile. A named native development profile may select `toolchain = "node-22"`. Nix and Guix
own their own tool versions and reject native profile overrides. Existing per-root compatibility declarations can still
request focused runtime tests; the reference uses named profiles so selections are also useful in development.

## Host caches or prepared images

Native hosts install and verify declared tools. `[ci.cache.artifacts]` selects `"cache"` or `"download"` for artifact
groups such as `llvm`, `gcc`, `rust`, `node`, `java`, `go`, `cmake`, `ninja`, and `uv`. Downloads remain locally
reusable within a job. LLVM and GCC default to downloading authenticated, filtered binaries; GCC requires Linux with
glibc 2.28 or newer. Rust and costly source builds can be retained. Package download stores are cached; installed
project dependencies are recreated. Explicit Miri checks install their separate nightly only when requested.

Linux CI can use the same prepared images as offline development:

```toml
[ci.images]
native = "native"
nix = "nix"
guix = "guix"
```

Each value names a configured development profile with a `container_config` and an `offline` declaration. Its local
workspace may remain `host`; CI selects the prepared container independently. Omit `ci.images.native` to exercise native
installation and cache execution on Linux. macOS and Windows always use native host execution. Nix and Guix CI require
published prepared images; their host shells remain available for local development. Hosted CI pulls the matching Nix or
Guix image from the configured registry and fails if it cannot retrieve it. Build and publish these images locally
before pushing a recipe or dependency-pin change; hosted CI never builds them.

Preparation uses the checked-in Dev Container recipe. Its builder, architecture, recipe, OS repository snapshot, and
locked inputs determine the tag. During local preparation, Workbench checks local images, then tries the configured
registry. If retrieval fails, including transport or authorization failures, it reports the cause and builds locally
from the same pinned recipe. Local preparation still needs its base images and dependency inputs available locally or
downloadable. Retrieved images must match the declared inputs and pass fresh offline verification; publication failures
remain errors. No compiler emulation is selected. `development prepare PROFILE --build` explicitly selects a local
recipe build for initial preparation or recipe verification; it bypasses local-image and registry reuse.

## Preparing and retaining project images

The reference's three builder profiles prepare all registered roots. `offline.inputs` lists files/directories that
define image contents and environment closures; preparation helpers and cache handling are separate. `offline.verify`
runs in a fresh checkout with networking disabled and without host caches. Optional `offline.paths` restricts which
roots the profile supports. Recipes retain SDKs and dependency inputs, not successful project build outputs. The native
recipe installs verified tools; managed recipes retain their own builder stores.

Native preparation runs the configured CI check roles, including formatting, analysis, and coverage, to acquire their
dependencies. It repeats those checks offline against fresh source before accepting the image. Advisory queries run
separately in CI because their databases must remain current. Managed images acquire dependencies from their package
definitions.

`offline.registry` names a project-owned OCI repository with an explicit registry host and no tag (for example,
`ghcr.io/owner/project` or `registry.example.com:5000/team/project`). Docker handles registry authentication; the
provided GitHub workflow authenticates to GHCR. Architecture and input hash supply the tag:

```sh
workbench development prepare native
workbench development verify native
workbench development publish native
workbench shell --profile native --workspace devcontainer
```

Run `workbench development images` to see local preparation, registry availability, full image references, and
diagnostics in one table for the host architecture. Long references wrap to fit the terminal. In a terminal, select
profiles to prepare, then separately select prepared images to publish. Each selection includes Select all and Select
none; Esc stops the interaction. Preparation may retrieve an existing registry image instead of building. Already
prepared images skip preparation, and already published images skip publication. Profiles without a configured registry
can be prepared locally. Preparation installs the locked Dev Container CLI when needed.

Use `workbench development images --list` for the status table without prompts, or `--json` for structured status.
`--require` also stays read-only and exits unsuccessfully if any selected image is unavailable in its configured
registry. Redirected output and CI never prompt. The explicit `prepare` and `publish` commands remain available for
automation; interactive preparation and publication require a native Linux x64 or ARM64 builder.

Preparation and verification keep receipts in the local Workbench cache without changing the working checkout.
Publication first verifies fresh source builds and execution offline, then pushes the image and pulls its registry
digest to confirm the published identity.

Deleting an image is manual: use `docker image rm REFERENCE` locally or the GHCR package interface remotely. There is no
automatic pruning, promotion, or inferred supersession. An old checkout selects its own configuration hash and can
rebuild a missing image. These images are internal to the project; other projects prepare images from their own
declarations.

The separate explicit publication workflow publishes verified development and release images. Check jobs have read-only
registry access and never publish. Publication verifies registry digests and executable artifacts. Credentials are
supplied at invocation and are never included in preparation inputs or image layers.

## Local Linux rehearsal

`workbench ci` or `make ci` runs every configured Linux x64 target by default. It shares target resolution, image
recipes, and execution phases with GitHub. Inspect first or select a subset:

```sh
workbench ci --plan
workbench ci --plan --json
workbench ci --path examples/languages/python
workbench ci --target TARGET_ID --no-release
```

The rehearsal freezes the working tree without staging it, gives each job its own workspace and output paths, and bounds
concurrency with user/checkout `[execution].cpus_per_job` and optional `max_jobs`. Shared acquisition caches use locks.
Logs, coverage, release artifacts, and the combined result manifest remain in the printed report directory; disposable
workspaces are cleaned after execution. Unknown or empty selections fail.

Local Linux results do not prove macOS, Windows, ARM64, GitHub permissions, or registry publication. Verify those using
the corresponding native hosted jobs. No Linux container run on macOS or Windows substitutes for a native build.
