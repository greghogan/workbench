# Continuous integration

Workbench resolves CI coverage from `workbench/config.toml`, registered language roots in `workbench/projects.toml`, and
their commands. `workbench checks` inspects the local gate; `workbench checks matrix` prints CI coverage. Use
`--grouped` for hosted jobs or `--targets` for exact roots, tool selections, phases, and commands.

## Reference coverage

The reference workflow runs all language and framework examples on Linux x64, Linux ARM64, macOS ARM64, and Windows x64.
Each native platform job includes Workbench's supported Node profiles. Linux also exercises the selected GCC profile;
Clang remains the default and LLVM supplies formatting and analysis in both cases. Examples otherwise use their selected
development release and static minimum API targets. Nix and Guix each run Workbench and every example in a prepared
Linux x64 environment.

Every push, pull request, and manual run checks all configured roots. There are no changed-path filters. Coverage
replaces the ordinary suite only where configured, and reports its difference from the recorded summary. Native release
artifacts are prepared and exercised outside their source checkout. Independent targets continue after a failure.

Consumers own their copied workflow and may select fewer platforms or one builder. Native, Nix, and Guix remain separate
tool authorities. Missing definitions or unavailable tools fail; Workbench does not silently choose another builder.

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
workbench checks run --toolchain gcc
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
native = "native-offline"
nix = "nix-offline"
guix = "guix-offline"
```

Each value names a configured development profile with `workspace = "devcontainer"` and an `offline` declaration. Omit
`ci.images.native` to exercise native installation and cache execution on Linux. macOS and Windows always use native
host execution. Nix and Guix CI require prepared images; their host shells remain available for local development.

Preparation uses the checked-in Dev Container recipe. Its builder, architecture, recipe, OS repository snapshot, and
locked inputs determine the tag. Workbench checks local images, tries the configured registry, and builds only after a
confirmed missing image. Transport and authorization failures remain errors. No compiler emulation is selected.
`development prepare PROFILE --build` explicitly selects a local recipe build for initial preparation or recipe
verification; it bypasses registry reuse without treating an authorization failure as absence.

## Preparing and retaining project images

The reference's three offline profiles prepare all registered roots. `offline.inputs` lists files/directories that
affect preparation; `offline.verify` runs in a fresh checkout with networking disabled and without host caches. Optional
`offline.paths` restricts which roots the profile supports. Recipes retain SDKs and dependency inputs, not successful
project build outputs. The native recipe installs verified tools; managed recipes retain their own builder stores.

`offline.registry` names a project-owned GHCR repository without a tag. Architecture and input hash supply the tag:

```sh
workbench tools install --devcontainer
workbench development prepare native-offline
workbench development verify native-offline
workbench development publish native-offline
workbench shell --profile native-offline
```

Preparation and verification leave the working checkout unchanged except for the project-owned
`workbench/image-catalog.json`. The catalog records input manifests, image identities, and verified publication digests
with UTC timestamps. Commit catalog changes to retain shared history. CI uploads each job's catalog alongside reports;
incorporate those entries into the project catalog during review. Artifact uploads alone are temporary retention.

Deleting an image is manual. Inspect the catalog, use `docker image rm REFERENCE` locally or the GHCR package interface
remotely, and retain the catalog entry. There is no automatic pruning, promotion, or inferred supersession. An old
checkout selects its own configuration hash and can rebuild a missing image. These images are internal to the project;
other projects prepare images from their own declarations.

Trusted hosted jobs may publish successfully verified development images. Pull requests never publish. Release image
publication remains the separate explicit workflow, with registry digest and executable-artifact verification.
Credentials are supplied at invocation and are never included in preparation inputs or image layers.

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
concurrency with `[execution].cpus_per_job` and optional `max_jobs`. Shared acquisition caches use locks. Logs,
coverage, release artifacts, and the combined result manifest remain in the printed report directory; disposable
workspaces are cleaned after execution. Unknown or empty selections fail.

Local Linux results do not prove macOS, Windows, ARM64, GitHub permissions, or registry publication. Verify those using
the corresponding native hosted jobs. No Linux container run on macOS or Windows substitutes for a native build.
