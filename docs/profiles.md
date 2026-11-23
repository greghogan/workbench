# Artifact and development profiles

Artifact profiles live in [workbench/profiles.toml](../workbench/profiles.toml). Select a profile and output kind each time
you build. The profile determines which projects, targets, formats, and recipes are available.

Run `workbench artifact` to build from a saved profile, build from a custom selection, or manage profiles. A custom
selection starts with an existing profile's recipes and defaults to the local target. Choose which outputs to make
available, then optionally save the selection under a new name. Choose the kinds to build and where to keep the outputs.
The menu offers publication when the selected outputs have a compatible destination.

```sh
workbench artifact list
workbench artifact build native --kind development --kind release --plan
workbench artifact build --all --kind release --plan
workbench artifact build native --kind release --format archive --export /path/to/transfers
```

`--all` selects matching outputs across the catalog for the chosen target or the local host. When you name a profile
explicitly, it must offer every requested kind for that selection.

Interrupting a build batch preserves completed outputs and reports the selections that did not start.

`artifact list` shows the state of retained outputs and the host requirements for building them. An outdated output
belongs to earlier profile inputs. Use `--sizes` for sizes and measurement times, or `--registry` to check configured
registries for the current image references. Registry results distinguish a missing image from an unavailable registry.
Sizes describe output bytes. Shared Docker layers can contribute to more than one image's size.
A matching image built in a different checkout is available for `artifact verify` without rebuilding it.

Toolchain images contain the selected tools and runtime libraries. Development images include locked project
dependencies for building a separate checkout offline. Release files carry the product and its runtime requirements.
Linux archive recipes produce a `.tar.gz` file. Archive recipes for macOS and Windows use ZIP.
For a directory-based release, give the recipe `package = {}` and have its build write files to `{output}`. Workbench
packs that directory and extracts the result for the verifier. POSIX release archives preserve contained symbolic links
and executable files. Windows ZIP recipes should produce ordinary files and directories.
Use `--export DIRECTORY` to choose a local destination for any supported format. Workbench creates the directory if needed.

For a file transfer, carry the exported directory and send its manifest SHA-256 through a trusted channel. On the
receiving host, select the matching profile, kind, target, and format with `workbench artifact import` and supply
`--sha256`. The receiver checks the manifest and the bytes and runs the recipe verifier before retaining the import.
Use `--unverified` explicitly when transferring a candidate before target verification.
A unique retained artifact with matching inputs is selected automatically, including a verified import. Verified
outputs take precedence over candidates awaiting verification. If several matching outputs contain different bytes,
`artifact inspect` lists the generation IDs. Use the ID shown at import or inspection with `--generation ID` to
inspect, verify, export, or publish exact bytes. Before publication, verify the release on its target from a clean
checkout of the tagged source revision.

For offline OCI transfer, use `workbench artifact export native DIRECTORY --kind development --format oci`, or
add `--export DIRECTORY` when building the image. Carry the resulting directory and send the manifest SHA-256
through a trusted channel. Import the matching selection with `artifact import` and `--sha256` on a host with Docker,
the pinned Dev Container CLI, and the project checkout. Workbench verifies the image with networking disabled before
selecting it for the profile. For a build that needs qualification on the destination, add `--unverified` when
exporting. The receiver follows the same import procedure.

A native Linux toolchain or development archive recipe declares `owner`, `native_profile`, and `bootstrap_image`.
Select a matching native preparation profile and load the digest-pinned bootstrap image on each host. The bootstrap
supplies OS prerequisites and the Workbench startup runtime. Workbench acquires pinned distributions in a private
cache and carries the original downloads and upstream proof files. Development archives also carry supported package
caches. On import, Workbench restores those inputs into a fresh cache, runs the native installer while disconnected,
and runs the profile verifier from a separate checkout. A recipe qualifies only if all its selected tools and
dependencies can be restored by this process.

Use an imported native archive with `workbench shell --artifact PROFILE`. Workbench restores its inputs into a
separate reusable cache and installs the pinned tools on the host. The host must provide the runtime prerequisites
declared by the target. A shell uses the current verified development archive by default. Pass `--generation ID`
for an exact import, `--kind toolchain` for a toolchain archive, or `--path ROOT` to select a covered language root.
Checks started in that shell inherit its cache and Workbench's offline setting.

```sh
workbench shell --artifact java -- workbench check --path examples/languages/java --role build --role smoke
```

For a manager-native export, declare a recipe with `owner`, `store_profile`, and `bootstrap_image`. Select an existing
managed preparation profile with the same kind and builder. Use `nix-export` or `guix-export` on the matching Linux
host. Workbench prepares the selected profiles and transfers their store dependencies through the file manifest
workflow. Load a digest-pinned bootstrap image with Node.js and the package manager before qualification. For Guix,
the exporting daemon needs a signing key, and the receiving bootstrap must authorize its public key.
Workbench restores the archive into a disposable container, pins its profiles, and runs the selected profile's
offline checks as an unprivileged user with fresh caches and networking disabled. The bootstrap must be free of the
selected profiles.
[Guix archive documentation](https://guix.gnu.org/manual/en/guix.pdf)

`workbench shell --artifact PROFILE` also accepts verified Nix and Guix exports with a pinned bootstrap. It restores
the store in a disposable container with networking disabled. The live checkout is mounted at the same path, and
the shell runs with the host user's numeric identity. Commands can edit the checkout, including linked Git worktrees.

A project with its own verifier can supply `verify` in place of `bootstrap_image`. It receives the authenticated
archive and a fresh checkout through the `{artifact}` and `{root}` arguments. Its verification must restore the archive
into an isolated store and exercise the project with networking disabled.

In the catalog, `targets` declare platforms and optional runtime, ABI, and CPU requirements. A profile names its
projects, builder, workspace, and supported target, kind, format, and recipe combinations. File recipes declare inputs
and literal build and verification arguments. The build writes `{artifact}`; the verifier receives a copy in its own
working directory. Use `verify_inputs` for project-relative scripts, fixtures, or other files used by the verifier.
Changes to those files invalidate verification. Files that also affect the build belong in `inputs` as well.
Use `{tag}` in release recipe arguments when the version affects the build or verification. Untagged builds supply
an empty argument. Pass `--tag TAG` to build, verify, or transfer the tagged variant. Its tag becomes part of its
artifact identity.
Release variants participate in CI packaging by default. For a variant verified separately, specify a nonempty
`ci_skip_reason`. The exclusion applies to routine CI packaging and leaves the variant available for explicit builds
and tagged releases.
Image recipes select a prepared development configuration. Use `artifact add`, `edit`, or `remove`
to preview a change, then `--apply` to save it. Existing declarations retain their comments.

With `cache.auto_prune` enabled, a verified local artifact build can retire older local builds of the same recipe
under `cache.max_generations` and `cache.max_age_days`. Active generations, explicitly retained assets, and verified
transfers remain available. Export files to a directory outside the managed artifact cache for permanent retention.

Run `artifact publish` to send a verified image to an OCI registry or verified release files to a configured GitHub or
GitLab release. `release publish` publishes the exact tagged source and writes a release record using the verified
published files. Select a destination declared with `kind = "github"` and its `repository`, or `kind = "gitlab"` and its
`host` and `project`. The hosted tag must already point to the reviewed source.
Build from a clean checkout to bind a release file to its Git revision for publication.

Add `--publish` to an `artifact build` command to publish all selected outputs after their builds and verification
succeed. For OCI images, this uses the profile registries unless you name a destination. For release files, supply
`--publish DESTINATION --tag TAG`. The verified outputs stay available locally if delivery fails. Rerunning an export
into the same directory reuses an existing transfer when its manifest and bytes still match.

To assemble a release across hosts, build, verify, and export each file from its target. Obtain each export's manifest
checksum directly from the trusted builder. From a clean checkout of the same source, run `artifact import` with the
appropriate `--target`, `--sha256`, and `--verified-on-target` to carry that verification to the publishing host. Pass
all the resulting IDs as repeated `--generation` values to `release publish`. The publisher matches each ID to a recipe
in the selected profiles and checks the digest and tagged source before delivering the release. Asset names and release
record entries identify the profile, target, and format so multiple builds for the same platform can ship together.

Generated CI workflows publish only when you configure `publication.branch` or `publication.tag`. Each rule selects
`refs` (exact names or a prefix ending in `*`), `profiles`, and a `destination`. A branch rule selects one `target`
and a `kind` of `toolchain` or `development` for OCI delivery. The workflow retains the source revision and every
verified registry digest, including successful deliveries when a later image fails to publish. A preparation job
exports verified images. The publishing job authenticates and imports them before logging into the delivery registry.
The runner and repository need space for the image exports.

On GitLab, use a delivery registry outside the source project's registry, with no write access for the source
pipeline's job token. Scope `WORKBENCH_PUBLISH_REGISTRY_USER` and `WORKBENCH_PUBLISH_REGISTRY_PASSWORD` to the
`workbench-publication-<destination>` environment and restrict that environment to authorized publishers. The
server's job artifact limit must accommodate the compressed image handoff. Use explicit `artifact publish` for images
that exceed the limit. [GitLab environment scopes](https://docs.gitlab.com/ci/environments/#limit-the-environment-scope-of-a-cicd-variable)
[GitLab artifact limits](https://docs.gitlab.com/ci/jobs/job_artifacts/)

A tag rule selects one `target` or a list such as `targets = ["linux-x64", "linux-arm64"]`. After the configured
checks pass, the target jobs stage verified package exports from the checks. A package without matching evidence is
built and verified on its target. One publishing job imports every required export from the same CI run, publishes the
release, and retains its release record.

## Development selection

`native`, `nix`, and `guix` select the tool authority. Select the host or Dev Container workspace independently:

```sh
workbench development profiles                # Show configured profiles and the active workspace
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

Nix container checks mount source read-only and create a disposable writable copy. Build and dependency caches mount
separately with host ownership preserved; the Nix store can persist between runs. Setup and dependent checks share that
container session.

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

The Guix runtime retains its network service/protocol databases and initializes a missing substitute-key ACL from the
public keys shipped by the pinned Guix runtime. An existing ACL remains under the container operator's control. This
allows signed substitute acquisition during ordinary networked development as well as offline use of retained inputs.

CI mounts a fresh checkout and runs the selected Workbench executable from that checkout or its pinned distribution. The
executable and project sources are supplied when starting the container; updating them does not rebuild a dependency
image. Preparation establishes matching offline verification evidence; publication verifies the current checkout through
a fresh offline build and execution. By default, verification uses the shared recipe's `build` and `smoke` roles for the
profile's `offline.paths`, or all registered language roots when paths are omitted. It does not require matching CI
targets. All ten bundled language starters use executable README console examples as their smoke commands, reusing their
ordinary documentation checks. Project-owned language definitions or additional checks can supply application smoke
commands; `offline.verify` optionally replaces the complete verifier. The native shared preparation recipe also runs
each root's `acquire` role to retain locked inputs without executing full test suites. Complete lint, unit, coverage,
and browser suites run through CI, independently of image qualification.

Workbench validation checks that managed profiles include the source files named by each selected root’s
`managed-check-inputs.json`. Directory inputs cover their contained files. The lists remain project-owned. Native images
place installed tools and dependency downloads in separate layers so download changes can reuse the tool layer.

The checkout is bind-mounted, and the workspace runs as an ordinary user while package-manager daemons run as root.
Development containers have network access and use their retained inputs without host dependency-cache mounts. Their
offline verification runs separately with networking disabled. Configured retention may prune owned local cached images,
protecting active and explicitly retained images. Published registry image and container deletion remains explicit;
Workbench preserves active work when an existing container no longer matches the selected image.

## Release preparation

```sh
workbench artifact list
workbench artifact build go-native --kind release --plan
workbench artifact build go-native --kind release --export /path/to/transfers
workbench artifact build go-nix-portable go-guix-portable --kind release
```

The shared catalog associates each recipe with its owning project. A profile selects target variants and formats.
`workbench tools profiles` lists compiler and runtime choices independently. `make release` runs the language's
local release check roles.

The example profiles target Linux x64, with an additional ARM64 Rust musl profile. A foreign platform fails before
building; preparation does not automatically emulate another architecture. Use a builder native to the declared
platform. The provided reference recipes are:

| Builder | Formats                                                                                                  | Verification                                                               |
| ------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Native  | Go, Java, and Rust musl archives                                       | Copied executable; musl linkage checks and offline Ubuntu/Alpine execution |
| Nix     | Exported closure, portable static tarball, Docker archive                                                | Fresh store import or offline container execution                          |
| Guix    | Relocatable (`-R`) and really relocatable (`-RR`) tarballs, Docker archive, Squashfs, Apptainer workflow | Offline container execution without the application's builder store        |

All eleven examples provide a Nix closure and a really relocatable Guix tarball, prepared from the same package
definition used by their development environment. Go additionally demonstrates the other formats above. For example:

```sh
workbench artifact build cpp-nix-closure cpp-guix-portable --kind release
workbench artifact build react-nix-closure react-guix-portable --kind release
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

The Go example's `go-guix-squashfs` profile produces a SquashFS pack that Apptainer can run directly. The existing
Nix lock supplies Apptainer because the example's pinned Guix channel has no Apptainer package. The verifier extracts
the pack using `--unsquash` and needs no FUSE device. Nested Apptainer uses user namespaces and explicit Docker seccomp
and system-path exceptions inside the disposable offline verification container.

### Recipe contract and output

A file recipe can write its payload directly to `{artifact}`. To keep a packager that produces a directory, declare
`package = {}`. The build receives a private `{output}` directory through the `WORKBENCH_RELEASE_OUTPUT` environment
variable. On Linux, Workbench archives that directory and reconstructs it for the verifier in private storage.
Use `package = { file = "count.squashfs" }` when the builder supplies a single file in its final format. Workbench
retains those bytes and presents them under the declared name to the verifier.

Build and verify are literal argument arrays. Recipes can use `{source}` for the owning project, `{workbench}` for the
active distribution, and `{nix_image}` for the configured pinned Nix runtime. Build runs from the language root,
while verification runs outside the checkout against a staged copy. It exercises the packaged program and runtime
dependencies.

The command reports the retained artifact generation, and `--export DIRECTORY` copies the payload and its manifest.
The manifest identifies the payload bytes, selected recipe, source revision when clean, and verification.
Publication is a separate step using the verified generation.

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
workbench artifact build native --kind development --format oci
workbench development use native --workspace devcontainer
workbench shell --path examples/languages/go -- go test ./...
```

Preparation reuses a matching local image or tries the configured registry before building the configured recipe.
Registry retrieval failures are reported before a local build; required base images and dependencies must still be
available. `artifact build --force` skips image reuse. To build a Nix or Guix image locally, select that
manager's store in personal configuration. For example, use `workbench config set preparation.guix_store system` for the
host daemon or `workbench config set preparation.nix_store managed` for Docker. Each defaults to `disabled`. Pulling or
verifying a prepared image requires no store selection.

Managed stores live under `managed-stores/nix` or `managed-stores/guix` in the Workbench cache. Projects can reuse
packages when they use the same Docker engine, bootstrap closures, and store trust configuration. Builds for different
target architectures can share the host bootstrap and architecture-independent inputs. Each target retains its own
profile roots, so retiring one target lets the manager reclaim its unused objects while preserving the other target
and their shared inputs. Ordinary Docker volume cleanup removes the mounts and the next preparation recreates them
from the retained cache directories.

The Builders section of `workbench cache` shows shared store sizes, eligible profile roots, and pending work. If
assembly stops after creating managed store roots, cache inventory keeps those roots protected and shows the command to
retry the preparation. A successful retry with the same inputs reuses their store and records the roots with the image.
`workbench cache prune --checkout builders` previews cleanup or prompts for confirmation in a terminal. Cleanup releases
verified staging archives and superseded profiles, then lets the store's package manager reclaim unreachable packages.
Other projects' pins and explicitly retained profiles remain live. Workbench releases its own system-store profiles
through dependency pruning. The system administrator controls garbage collection for those stores.

Successful local verification can be reused when its immutable image, complete frozen source and Workbench distribution,
verification command, Docker host, and effective execution environment match. `development prepare PROFILE --fresh`
forces verification; CI, explicit verification, and publication retries can reuse matching evidence no older than 30
minutes. Missing or uncertain evidence also runs fresh. Verification mounts a separate source snapshot into the
immutable image with `--network=none`. Verification has no host dependency-cache mounts or installed project outputs; it
compiles and tests current source. Native installation uses Workbench's verified installer. Nix and Guix assemble images
directly from their declared development closures, including locked check dependencies. Nix submits subproject
environments to one builder graph. Guix groups them by effective channel declaration and evaluates each group with its
matching Guix, then assembles the realized profiles without re-evaluating manifests. Both retain separate profiles for
each root; Guix also retains each group's runtime. Image preparation does not run project builds or language package
managers. Native images retain verified tools and dependency downloads. Advisory checks requiring live services remain
online operations; an offline build does not claim fresh vulnerability information.

Waiters observe busy preparation locks without mutating their metadata. Inspect profile, managed-builder, and BuildKit
ownership with `workbench development locks PROFILE`. To recover a demonstrably abandoned lock, select its returned
digest with `workbench development recover PROFILE --lock profile --expect DIGEST` (or `--lock builder` /
`--lock buildkit`). Use `--lock store` for a managed store lock. Use the same `--architecture` on both commands for an
emulated build. Recovery rechecks the exact owner, local child-process scope, and container activity. Active owners,
foreign hosts, incomplete launch evidence, and uncertain engine state are preserved. Managed store recovery verifies the
store's Docker engine and checks for surviving processes and containers that still mount the store. For other
preparation locks, release the activity scope and drain Workbench containers and builders before recovery. Older locks
without child-process ownership evidence require operator investigation.

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

`paths` optionally selects registered language roots; `inputs` lists files that determine image contents, such as pins,
locks, environment definitions, and copied build helpers. The identity includes the builder, target architecture and
selected roots. Native profiles also include configured tool selections. The standard Dev Container builder includes its
container JSON; a custom `prepare` command owns its explicit content inputs instead. Workspace selection, registry
location, verification commands, and the independently pinned Workbench executable do not invalidate a dependency image.
Input directories follow the Git snapshot and exclude ignored caches; explicitly listed files must be included in that
snapshot. The example configuration includes Nix/Guix definitions and the native acquisition authority. Ordinary source
edits reuse the image and require fresh verification when that source differs from the accepted evidence; changing a
declared input requires preparation again. Preparation does not change the active development profile. Failure preserves
the previous receipt.

An optional `prepare` command array builds the image instead of the Dev Container Dockerfile. It runs from a project
snapshot on the host; `{image}` names the local output image and `{workbench}` identifies its pinned distribution. The
reference recipes use the selected preparation backend, then assemble the final image with Nix dockerTools or Guix pack.
Each target architecture has separate profile identities. Guix also retains the native pinned channel manager and target
runtime. Docker-backed preparation runs the manager in a native bootstrap container. Foreign package builders execute
through the enabled binfmt handler. Profiles stay rooted even when automatic pruning is disabled. The Linux assembly
helper requires Docker, Bash, and tar on the host. Import streams directly to Docker; Nix and Guix use uncompressed
local import archives to avoid repeated compression. Docker handles registry layer compression when publishing. Both
image layouts expose the platform loader through `/lib` and `/lib64` for prebuilt development tools. Prepared Guix
commands also expose the selected profile's library directories; mutable caches remain outside the immutable store.

Managed Guix reuses a compatible standard bootstrap across projects with the same recipe and channel pins. Run
`workbench development prepare PROFILE --refresh-bootstrap` to rebuild locally with a fresh bootstrap. `--fresh` repeats
offline verification.

Guix host checks keep the previous environment rooted until the replacement succeeds and its stable root is registered.
An interrupted publication retains a pending root until retry or explicit dependency pruning.

From a prepared Workbench checkout, run `pnpm run tooling:maintainers`, then
`node scripts/verify-managed-preparation.mjs guix` or `node scripts/verify-managed-preparation.mjs nix` to rehearse
managed image assembly with two tiny profiles. This explicit integration check requires the selected manager installed
on Linux and Docker. It uses temporary project caches, executes both profiles with networking disabled, and removes its
profile roots and newly imported image tags. Store outputs remain eligible for the manager's ordinary garbage
collection. Add `--subproject-pin` to the Guix rehearsal to exercise a separate subproject declaration at the existing
pinned revision. Routine tests exercise the script entry points with isolated tool fixtures.

Pass `--store managed` with either manager to qualify its Docker-backed store. The script prepares two independent
projects in a disposable Workbench cache, checks pin reuse through Docker volume recreation, and prunes an obsolete
profile. Successful qualification removes the disposable store and image tags.

Metadata refresh collects and verifies all requested sources before replacing project files. Generated declarations and
recipes likewise finish generation first; each file replacement is atomic.

`node scripts/managed-inputs.mjs` derives check-source declarations from language locks. Run it after lock changes;
`--check` verifies declarations without fetching. `node scripts/refresh-managed-inputs.mjs` refreshes supplemental
metadata for already-pinned bootstrap, build-backend, and Go proxy inputs, together with compressed pnpm registry
publication and trust-history snapshots. Managed pnpm checks read those snapshots through an operation-owned loopback
registry; tarball extraction and supply-chain policy checks remain pnpm's responsibility. The refresh does not resolve
newer dependency versions. This supplemental refresh is a Workbench source-checkout maintenance command; complete
development setup first to generate the helper.

The verification command runs from the project root inside the fresh source snapshot. `{workbench}` expands to that
snapshot's Workbench distribution when the command needs its CLI or a shipped helper.

Prepared containers use one image and a literal `workspaceFolder`. Prepare dependencies in the image recipe rather than
lifecycle commands. Additional mounts, Compose, and network overrides are rejected. Managed profiles reject compiler
Features. The Guix recipe declares `WORKBENCH_GUIX_TIME_MACHINE_PROFILE` for its retained authenticated profile; offline
execution uses that profile without contacting channel repositories.

### Architecture and emulation

Preparation, verification and publication run on a Linux Docker host. On Windows use WSL 2. The default target matches
the host architecture. To prepare the other architecture, explicitly select it throughout the workflow:

```sh
# On Linux x64 with an ARM64 emulator registered:
workbench artifact build native --kind development --target linux-arm64 --format oci
workbench artifact publish native --kind development --target linux-arm64 --format oci
workbench development images native --architecture arm64 --require
```

Use `--target linux-x64` for build and publication on Linux ARM64 for the reverse direction. The same commands support
`nix` and `guix`. Preparation verifies fresh source offline. Use `artifact verify` with the same selection to verify
independently. Verification and publication can reuse matching evidence within their documented freshness window. Foreign
execution requires explicit target selection and prior emulator setup.

The Docker host must already have an enabled binfmt_misc interpreter with the `F` flag for the target. That registration
allows static QEMU to run inside container and package-manager namespaces and must be restored after a host restart.
Review the emulator dependency before an administrator installs it; Workbench does not perform privileged setup. The
[Docker multi-platform guide](https://docs.docker.com/build/building/multi-platform/#install-qemu-manually) describes
the kernel and interpreter requirements. Emulation shares the host kernel and can be substantially slower for
source-heavy builds.

Docker selects the target platform for native images. Nix and Guix run their managers on the host architecture and
realize the requested target in the configured store. Before verification, Workbench checks both the image metadata and
the running container's architecture. Each target has its own receipt identifying the verification host, target, and
native or binfmt method. Emulated offline verification is sufficient for explicit development-image publication;
complete the native CI matrix to verify platform support for a Workbench release.

`--assemble-only` stops before verification and cannot activate or publish an unverified image. An assembled image can
be transferred with Docker save/load, then independently accepted with
`development verify PROFILE --architecture TARGET --image sha256:ID`. The explicit publication workflow prepares all
three builders on native x64 and ARM64 runners. macOS and Windows use native hosted runners and tool caches, without
publishing operating-system images.

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

Use lowercase owner and repository names. The command first establishes local offline verification (or reuses matching
evidence from the last 30 minutes), pushes the selected image, and resolves the tag at the registry. It pulls that
digest and checks the image identity against the verified local image. An existing input-derived tag is reused if it
serves the verified image. Conflicting bytes are preserved and reported. Workbench records the immutable
`ghcr.io/...@sha256:...` reference after verification.
Authentication is external; Workbench neither stores nor prints registry tokens. A local destination tag pointing to
another image blocks the upload. A failed post-push verification cannot retract a registry upload; the command
reports failure and does not record the image as verified publication. Tags can be updated by the registry; consumers
should pin the returned digest.

A consumer can use that digest as the `image` in its standard Dev Container JSON and configure its own offline profile.
`development prepare` pulls the pinned image and verifies it against that consumer's current source and declared
command, without requiring the builder on its host. Live GHCR credentials and permissions require hosted verification;
local tests exercise publication ordering and failures without uploading images.

The explicit `publication.yml` workflow builds and publishes native, Nix, and Guix images on x64 and ARM64. Choose
`toolchain` or `development` when dispatching it. Each build verifies the selected image offline and transfers it to a
separate publishing job. That job authenticates and qualifies the transferred bytes before signing in to the registry.
The workflow retains receipts and can run before Checks, which needs its configured images to exist. The separate
`release.yml` workflow publishes the exact Workbench archive from a successful complete Checks run.
See [release publication](contributing.md#hosted-ci-operations-and-publication).
