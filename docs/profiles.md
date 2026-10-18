# Development and release profiles

Profiles are project-owned declarations in [workbench/config.toml](../workbench/config.toml). They select an execution
workspace or a release recipe. Shared language definitions remain independently replaceable; profile declarations do not
merge with another project's declarations.

## Development selection

`native`, `nix`, and `guix` select the tool authority. Select the host or Dev Container workspace independently:

```sh
workbench development                         # Show profiles and the active workspace
workbench development use                     # Choose a profile interactively
workbench development use nix --workspace host
workbench development use guix --workspace devcontainer
workbench development use --workspace host    # Keep the builder and change the local workspace
workbench shell --profile nix --workspace devcontainer --path examples/languages/go -- go test ./...
workbench check --profile native --workspace host --path examples/languages/go
workbench config set development.workspace devcontainer
```

Selection writes `workbench/local.toml` without changing shared configuration, CI, or releases. A profile declares its
builder, default `workspace`, and optional `container_config` and `offline` preparation inputs. A host profile can carry
its container recipe. `--workspace` overrides the local preference for one command; it requires a configured profile.
`--environment` selects an execution environment directly and cannot be combined with `--profile` or `--workspace`.
Managed shells remain bound to their builder and language root; leave the shell before changing that selection.

| Profile  | Tool authority                       | Host workspace requires | Container workspace requires            |
| -------- | ------------------------------------ | ----------------------- | --------------------------------------- |
| `native` | Native tool declarations             | Declared native tools   | Docker and the locked Dev Container CLI |
| `nix`    | Locked flakes                        | Nix                     | Docker and the locked Dev Container CLI |
| `guix`   | Authenticated channels and manifests | Guix                    | Docker and the locked Dev Container CLI |

Container startup reuses a prepared image, acquiring and verifying it when needed. Its host needs neither Nix nor Guix.
Each profile owns one standard `devcontainer.json`; the native configuration is `.devcontainer/devcontainer.json`.
Editors and the upstream Dev Container CLI can also open these checked-in definitions directly.

### Package-derived development inputs

For Guix and Nix, the package definition owns release build inputs. The development manifest or shell derives those
inputs and adds check tools and interactive utilities: Git, OpenSSH, rsync, which, a pager, and an editor. C/C++
development includes LLDB and adds GDB when GCC is a development compiler; GCC runtime libraries alone do not trigger
GDB. Release images retain the application and runtime closure, excluding development utilities.

The C/C++ references select GCC and Clang within the authenticated channel through `guix-toolchain.scm`. When the
channel's Clang uses another GCC, the helper rebuilds it with the selected GCC and matching runtime libraries, then
derives LLVM and LLDB from that toolchain. Selecting a different Guix GCC can therefore require rebuilding Clang, LLDB,
and affected native dependencies once. Subsequent shells reuse the same realized store paths.

Guix host shells, checks, releases, and prepared images use a subproject’s `channels.scm` when present, otherwise the
configured project’s root file. A subproject declaration is a complete replacement. Workbench’s examples share the root
pin; each keeps its own package definition and development manifest.

Host Nix and Guix shells and checks register persistent garbage-collector roots separately for each checkout, language
root, platform, and environment identity. Ordinary `nix-collect-garbage` or `guix gc` preserves those environments
between sessions. Guix uses one profile symlink in its per-user profiles directory, with an ownership receipt in
Workbench's dependency cache. This lets an unprivileged Guix daemon read the root without access to private cache
directories. Nix uses its standard development-profile links in the dependency cache. Project outputs can remain in the
checkout while ownership records live in the configured cache storage.

`workbench cache prune --dependencies` releases the selected registrations; the package manager can reclaim unreferenced
store contents on its next garbage collection. Ordinary cache pruning preserves them, and active shells or checks
prevent their deletion. Cache sizes count the registration files, not the shared Nix or Guix store closure. Prepared
container profiles are retained within their images independently of host registrations.

### Container workspaces

The reference recipes prepare tools and dependency inputs for every registered root. Prepared images follow the same
builder authority as host development. Managed profiles reject independent compiler Features. Nix uses its locked
bootstrap closure; Guix bootstraps from signed Ubuntu packages and authenticates the pinned channel. No host package
manager or channel update is required.

Image identities include the builder, architecture, included roots, and declared image-content inputs in
`offline.inputs`: dependency locks, environment definitions, and image assembly definitions. Exclude orchestration
helpers, cache settings, bootstrap-container recipes, application source, tests, and CLI bundles. Custom preparation
commands and their workspace configuration do not define the image identity unless explicitly listed as content inputs.
The standard Dev Container builder also includes its build configuration, since that configuration constructs the image.
Native profiles additionally include configured tool selections.

The reference Nix image is defined by `.devcontainer/nix/image.nix`; Guix uses its image and environment Scheme
definitions and `.devcontainer/guix/image.json` for pack layout and account-file materialization. Their host/container
selection, BuildKit version, cache layout, resource limits, preparation commands, verification commands, and registry
location are independent of those definitions.

CI mounts a fresh checkout and runs the selected Workbench executable from that checkout or its pinned distribution. The
executable and project sources are supplied when starting the container; updating them does not rebuild a dependency
image. Preparation establishes matching offline verification evidence; publication verifies the current checkout through
a fresh offline build and execution.

Workbench validation checks that managed profiles include the source files named by each selected root’s
`managed-check-inputs.json`. Directory inputs cover their contained files. The lists remain project-owned. Native images
place installed tools and dependency downloads in separate layers so download changes can reuse the tool layer.

The checkout is bind-mounted, and the workspace runs as an ordinary user while package-manager daemons run as root.
Development containers have network access and use their retained inputs without host dependency-cache mounts. Their
offline verification runs separately with networking disabled. Docker image and container deletion remains explicit;
Workbench preserves active work when an existing container no longer matches the selected image.

## Release preparation

```sh
workbench release profiles                         # List configured recipes
workbench release prepare --plan                    # Inspect the default selection without building
workbench release prepare                           # Prepare all configured release profiles
workbench release prepare --all                     # Explicit equivalent
workbench release prepare go-native                 # One profile
workbench release prepare go-nix-portable go-guix-portable
```

Preparation executes project-owned argument arrays. It defaults to all configured profiles without a selection prompt.
It never changes the development preference. Existing check-role packaging remains available through `make release`;
named multi-format packaging uses `workbench release prepare`.

The example profiles target Linux x64, with an additional ARM64 Rust musl profile. A foreign platform fails before
building; preparation does not automatically emulate another architecture. Use a builder native to the declared
platform. The provided reference recipes are:

| Builder | Formats                                                                                                  | Verification                                                               |
| ------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Native  | Go executable directory; explicit Rust musl executable directories                                       | Copied executable; musl linkage checks and offline Ubuntu/Alpine execution |
| Nix     | Exported closure, portable static tarball, Docker archive                                                | Fresh store import or offline container execution                          |
| Guix    | Relocatable (`-R`) and really relocatable (`-RR`) tarballs, Docker archive, Squashfs, Apptainer workflow | Offline container execution without the application's builder store        |

All eleven examples provide a Nix closure and a really relocatable Guix tarball, prepared from the same package
definition used by their development environment. Go additionally demonstrates the other formats above. For example:

```sh
workbench release prepare cpp-nix-closure cpp-guix-portable
workbench release prepare react-nix-closure react-guix-portable
```

Rust also provides `rust-linux-x64-musl` and `rust-linux-arm64-musl`. Select the profile matching the native Linux
builder; the [Rust release guide](../examples/languages/rust/README.md#releases) describes prerequisites, portability
baselines, and checks. Ordinary `make release` keeps the selected environment's native target. Managed packages retain
their own runtime closures.

Each example owns its behavioral release checks. Verification imports the Nix closure into a fresh store or unpacks the
Guix archive in an offline container without the builder store or source checkout. Static sites are checked through
their built DOM behavior.

Nix recipes use a host Nix installation when available and otherwise the pinned Nix Docker adapter. Guix recipes use the
host Guix daemon and authenticated `channels.scm`. Preparation may fetch verified builder inputs. Behavioral
verification runs offline after its runtime is acquired. Application release images contain runtime closures;
development images contain tools and are separate artifacts.

Guix's Apptainer workflow consumes its Squashfs pack directly. The existing Nix lock supplies Apptainer because the
example's pinned Guix channel has no Apptainer package. The verifier extracts Squashfs with `--unsquash`, so FUSE device
access is unnecessary. Nested Apptainer uses user namespaces and explicit Docker seccomp and system-path exceptions;
these settings belong to the disposable, offline verification container. They are not CPU emulation.

### Recipe contract and output

Each `release.profiles` entry declares `name`, registered language `path`, `builder`, `format`, target `platform`, and
nonempty `prepare` and `verify` argument arrays. The coordinator validates combinations and locked builder inputs; the
recipe invokes the actual native, Nix, or Guix packager. Unsupported recipes fail visibly.

Preparation receives `WORKBENCH_RELEASE_OUTPUT`, `WORKBENCH_RELEASE_BUILDER`, `WORKBENCH_RELEASE_FORMAT`, and
`WORKBENCH_RELEASE_PLATFORM`. Literal argument placeholders are `{source}`, `{output}`, `{artifact}`, `{workbench}`, and
`{nix_image}`. They are substituted as argument text, without shell evaluation. The preparation command runs from the
registered source directory; verification runs from a private directory under the system temporary directory with
`{artifact}` pointing to an independent artifact copy. Its verifier must exercise the artifact's promised behavior and
runtime dependencies; it must not rebuild it.

Outputs are accepted by an atomic directory rename into `dist/releases/NAME`, under the checkout root's external build
generation when external storage is enabled, only after verification and unchanged artifact/source checks pass. Failed
staging and verification copies are removed. Existing accepted outputs are preserved; move them explicitly before
rebuilding a profile. Independent selected profiles can finish even when another fails, with an aggregate failure
reported.

`workbench-release.json` is reserved for the verification receipt. It records profile configuration, source file
identities and Git revision/dirty state, locked builder inputs, platform, artifact sizes and SHA-256 identities, and
verification/emulation results. This is local preparation evidence. It does not create a `REL` record, a Git tag, or a
registry publication. Publishing and testing GitHub Container Registry remain separate reviewed work.

Workbench's executable bundles are tool distribution artifacts, separate from these project release outputs.
`make release` prepares the runnable `workbench/` directory and `workbench-artifacts/workbench.tar.gz`, with
`SHA256SUMS`, under the selected distribution directory. The archive contains platform-neutral JavaScript, bundled
libraries and licenses, and the source, tests, and examples. It requires an installed supported Node.js runtime. Install
the archive with `npm install --global --ignore-scripts /path/to/workbench.tar.gz`; npm creates the `workbench` command
using its configured installation prefix. Extracting the archive and running `node workbench/bin/workbench.mjs` also
works.

Packages built from clean committed source include the canonical repository URL and exact revision in
`workbench-source.json`. Packaging verifies the selected file bytes, links, and executable modes against the Git tree;
Git status alone is insufficient. An installed package can serve the same project pin without acquisition. A different
pin still dispatches through npm. Development packages from dirty or uncommitted source remain runnable but carry no
immutable source identity. Archive entries use sorted paths, fixed timestamps and ownership, and readable permissions
independent of the build host. Git executable flags and contained symbolic links are preserved; packing does not publish
a release.

## Completion installation

```sh
workbench completion install bash
workbench completion install zsh
workbench completion install fish
workbench completion install powershell
workbench completion install bash --directory /tmp/workbench-completions
```

The installer writes one generated completion file and preserves unrelated files and shell startup configuration. Bash
and Fish use their standard user completion directories on Linux. Zsh reports the directory to add to `fpath` before
`compinit`; PowerShell reports the command to source from the profile. Custom directories and other platforms may
require explicit loading. `workbench completion SHELL` still prints the script.

## Completion scripts

Shell completion is generated from the command definitions, including command names, flags, scoped configuration keys,
and allowed values. It does not initialize projects or execute check commands. Enable it in your shell:

```sh
# Bash; add to ~/.bashrc
source <(workbench completion bash)
# Zsh, after compinit
source <(workbench completion zsh)
# Fish
workbench completion fish | source
```

For PowerShell 7, add `workbench completion powershell | Out-String | Invoke-Expression` to your profile. Completion
scripts are printed for review; Workbench does not edit shell startup files.

## Prepared development images

The `native`, `nix`, and `guix` profiles can prepare images for all configured roots independently of the selected
workspace. Install Docker and the locked Dev Container CLI:

```sh
workbench tools install --devcontainer
workbench development prepare native
workbench development verify native
workbench development use native --workspace devcontainer
workbench shell --path examples/languages/go -- go test ./...
```

Preparation reuses a matching local image or tries the configured registry before building the configured recipe.
Registry retrieval failures are reported before a local build; required base images and dependencies must still be
available. `development prepare PROFILE --build` skips image reuse. Successful local verification can be reused when its
immutable image, complete frozen source and Workbench distribution, verification command, Docker host, and effective
execution environment match. `development prepare PROFILE --fresh` forces verification; CI, explicit verification, and
publication always verify afresh. Missing or uncertain evidence also runs fresh. Verification mounts a separate source
snapshot into the immutable image with `--network=none`. Verification has no host dependency-cache mounts or installed
project outputs; it compiles and tests current source. Native installation uses Workbench's verified installer. Nix and
Guix assemble images directly from their declared development closures, including locked check dependencies. Nix submits
subproject environments to one builder graph. Guix groups them by effective channel declaration and evaluates each group
with its matching Guix, then assembles the realized profiles without re-evaluating manifests. Both retain separate
profiles for each root; Guix also retains each group's runtime. Image preparation does not run project builds or
language package managers. Native images retain verified tools and dependency downloads. Advisory checks requiring live
services remain online operations; an offline build does not claim fresh vulnerability information.

Inspect availability without downloading image layers:

```sh
workbench development images                    # All prepared profiles
workbench development images nix guix --require # Require both published images
```

The table distinguishes a missing manifest from authentication or transport failures. Hosted Nix and Guix jobs perform
this check before setup, then pull the required image. Local preparation still builds when registry retrieval fails.

The Guix recipes bound file descriptors during image builds and daemon startup. Older bootstrap daemons otherwise scan
Docker's potentially enormous inherited limit when starting children, adding minutes to each build step.

A profile with a container recipe adds a project-owned preparation table:

```toml
[development.profiles.offline]
paths = ["app"]
inputs = [".devcontainer", "app/go.mod", "app/go.sum", "app/.go-version"]
verify = ["node", "scripts/offline.mjs", "verify", "native"]
```

`paths` optionally selects registered roots; `inputs` lists preparation recipes, pins, locks, and environment
definitions. Workbench always includes the profile, its container JSON, and the independent Workbench executable pin
when configured. Declare every other preparation input explicitly, including copied helpers. Input directories follow
the Git snapshot and exclude ignored caches; explicitly listed files must be included in that snapshot. The example
configuration includes Nix/Guix definitions and the native acquisition authority. Ordinary source edits reuse the image
and require fresh verification when that source differs from the accepted evidence; changing a declared input requires
preparation again. Preparation does not change the active development profile. Failure preserves the previous receipt.

An optional `prepare` command array builds the image instead of the Dev Container Dockerfile. It runs from a project
snapshot on the host; `{image}` names the local output image and `{workbench}` identifies its pinned distribution. The
reference managed recipes use the installed Nix or Guix and its host store when available, then assemble the final image
with Nix dockerTools or Guix pack. Host preparation registers the per-root development profiles against garbage
collection; Guix also retains the pinned runtime. Missing managers use bootstrap containers with persistent,
builder-specific Docker store volumes. Those volumes retain successful package work after a later failure and appear in
Workbench cache reporting and explicit pruning. A failed installed manager is an error, not a fallback. The Linux
assembly helper requires Docker, Bash, and tar on the host. Import streams directly to Docker; Guix uses an uncompressed
local import archive to avoid repeated compression. Docker handles registry layer compression when publishing. Prepared
Guix commands expose the selected profile's library directories for compatible prebuilt development tools; mutable
caches remain outside the immutable store.

`workbench cache --checkout builders` reports fallback Docker stores; `cache prune --checkout builders` selects paired
store/state volumes together. Attached containers and active preparation protect them. Volumes without a matching
Workbench ownership receipt are reported but retained; a subsequent preparation registers reused volumes. Pruning
builder stores leaves prepared images intact. Host profiles are part of the owning project's dependency cache and are
released with `cache prune --dependencies`.

To rehearse managed image assembly with two tiny profiles, run `node scripts/verify-managed-preparation.mjs guix` or
`node scripts/verify-managed-preparation.mjs nix` from a prepared Workbench checkout. This explicit integration check
requires the selected manager installed on Linux and Docker. It uses temporary project caches, executes both profiles
with networking disabled, and removes its profile roots and newly imported image tags. Store outputs remain eligible for
the manager's ordinary garbage collection. Add `--subproject-pin` to the Guix rehearsal to exercise a separate
subproject declaration at the existing pinned revision. Routine tests exercise the script entry points with isolated
tool fixtures.

Metadata refresh collects and verifies all requested sources before replacing project files. Generated declarations and
recipes likewise finish generation first; each file replacement is atomic.

`node scripts/managed-inputs.mjs` derives check-source declarations from language locks. Run it after lock changes;
`--check` verifies declarations without fetching. `node scripts/refresh-managed-inputs.mjs` refreshes supplemental
metadata for already-pinned bootstrap, build-backend, and Go proxy inputs, together with compressed pnpm registry
publication and trust-history snapshots. Managed pnpm checks read those snapshots through an operation-owned loopback
registry; tarball extraction and supply-chain policy checks remain pnpm's responsibility. The refresh does not resolve
newer dependency versions.

The verification command runs from the project root inside the fresh source snapshot. `{workbench}` expands to that
snapshot's Workbench distribution when the command needs its CLI or a shipped helper.

Prepared containers use one image and a literal `workspaceFolder`. Prepare dependencies in the image recipe rather than
lifecycle commands. Additional mounts, Compose, and network overrides are rejected. Managed profiles reject compiler
Features. The Guix recipe declares `WORKBENCH_GUIX_TIME_MACHINE_PROFILE` for its retained authenticated profile; offline
execution uses that profile without contacting channel repositories. Images must match the native Linux architecture; no
emulation is selected. Linux x64 is verified locally; Linux ARM64 requires native verification. On Windows use WSL 2.

Workbench records accepted image IDs, input hashes, verification time, and any published digest under the platform
user-cache `offline-profiles` directory. Docker retains image bytes separately. Deleting a receipt requires preparing
again; deleting Docker images requires recreating or pulling them. Updating verification for the same immutable image
preserves its last verified publication digest; a different image requires its own publication evidence. Workbench never
prunes unrelated Docker images or containers. Owned references have a local history under the user-cache
`prepared-images` directory, retained after image deletion. Preparation and verification remove their own temporary
workspaces and verification containers. Workbench disables automatic UID rewriting for accepted images; choose a
workspace user whose permissions allow writes to the checkout. Opening a prepared container retains the working-checkout
mount and container session, with normal networking and no host dependency-cache mounts. Only verification disables
networking.

`offline.registry` selects an explicit OCI registry and repository, without a tag. Docker uses its normal credentials
for that registry. `development prepare PROFILE --pull-only` requires a registry pull and never builds locally. Nix and
Guix preparation automatically uses this restriction in CI; even `--build` is rejected there. Local preparation retains
the local-image, registry, then build workflow. GHCR is the reference registry exercised by the hosted workflows.

### Publish a prepared image to GHCR

Authenticate with Docker's normal credential lookup, then explicitly select the destination:

```sh
workbench development publish native --image ghcr.io/OWNER/PROJECT-dev:TAG
```

Use lowercase owner and repository names. The command first repeats local offline verification, pushes the selected
image, pulls its registry digest, and checks that its image identity matches the locally verified image. It prints and
records the immutable `ghcr.io/...@sha256:...` reference. Authentication is external; Workbench neither stores nor
prints registry tokens. Existing local destination tags are preserved by rejecting their reuse. A failed post-push
verification cannot retract a registry upload; the command reports failure and does not record the image as verified
publication. Tags can be updated by the registry; consumers should pin the returned digest.

A consumer can use that digest as the `image` in its standard Dev Container JSON and configure its own offline profile.
`development prepare` pulls the pinned image and verifies it against that consumer's current source and declared
command, without requiring the builder on its host. Live GHCR credentials and permissions require hosted verification;
local tests exercise publication ordering and failures without uploading images.

The explicit registry-verification workflow covers native, Nix, and Guix offline development images alongside release
images. It requires successful complete Checks for the same revision, uses a distinct tag for each workflow attempt, and
retains publication receipts. It is separate from ordinary push and pull-request checks.
