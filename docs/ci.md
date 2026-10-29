# Continuous integration

Workbench resolves CI coverage from `workbench/config.toml`, registered language roots in `workbench/projects.toml`, and
their commands. `workbench pre-commit` runs the commit gate; `workbench check matrix` prints CI coverage. Use
`--grouped` for hosted jobs or `--targets` for exact roots, tool selections, phases, and commands.

The reference workflows use GitHub Actions and GHCR. Git hooks work independently of the Git host. Use
`workbench ci setup --remote REMOTE` to generate GitHub Actions or GitLab CI/CD workflows with paired registry defaults,
explicit registry overrides, and destination-specific push checks. See [hosts, adapters, and registries](ci-hosting.md)
for setup, runner requirements, capabilities, and multiple destinations. Release archive publication currently uses the
separate GitHub adapter. The provider-independent policy is defined in [ADR-Y](../workbench/decisions/ADR-0Y.md).

Use `workbench ci` for the complete configured Linux x64 rehearsal, including CI-stage advisories, tool profiles,
managed images, and release verification. A passing commit gate or prepared image's offline verification does not
establish that this complete CI gate passes.

Run `workbench pre-push` for the separate online checks, including dependency advisories. It uses fresh results and does
not repeat the offline test gate. CI includes these checks automatically; the complete Linux rehearsal remains
`workbench ci`.

## Network acquisition and failures

Transient connection failures, rate limits, and upstream HTTP 5xx responses use up to eight attempts with exponential
backoff and jitter. Declared artifact mirrors are tried before waiting, and `Retry-After` is honored within a bounded
delay. SDK archives and their proofs retry complete private transfers; incomplete bytes never become installed inputs.
Authentication, certificate, checksum, signature, and malformed-content failures remain errors. Cancellation interrupts
waiting and prevents further attempts. Retries share the acquisition deadline; a prolonged outage fails with the
operation, attempt count, endpoint failure, and retained cause rather than reporting an unchecked input as verified.

CI acquisition commands use the same policy for host prerequisites, registry manifests and pulls, the pinned cross
driver, and release metadata and downloads. Commands have no implicit overall deadline; callers may select one, and CI
job limits and cancellation remain effective. HTTP acquisitions retain their scoped request and transfer limits. Retry
events identify attempts, delay, elapsed time, and exhaustion. Release downloads are private until complete; publication
writes are not retried automatically. Compilation and tests are not replayed as network recovery. Hosted adapters put
failure explanations in job annotations and summaries, with full output and operation reports retained for diagnosis.
Pinned third-party actions retain their own transport retry behavior.

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

Native targets with manual `integration` checks (`stages = []`) run those checks after their ordinary CI gate and before
release preparation. Checks already assigned to the CI stage run within that gate, once. Workbench uses the separate
phase for the ten-language installed-consumer suite on each native platform. The phase is independent of release
selection and runs with `workbench ci --no-release`; named toolchain profiles and managed environments retain their own
configured checks. Run the suite directly with `workbench check --role integration --path . --environment native`. See
[consumer integration and release preparation](contributing.md#consumer-integration) for scenarios, reports and
candidate verification.

Workbench's `browser` role runs the shipped web interface in the pinned Headless Shell during each configured CI gate.
Native tools provide the platform binary; native Linux preparation also supplies system libraries and fonts. Nix and
Guix provide the engine with their own library closures in their development manifests and prepared images. Local commit
gates retain the HTTP and DOM suites; run the browser workflow explicitly with
`workbench check --path . --role browser`. Browser scenarios isolate project and local-collection state from their
caller. Default runs copy screenshots, diagnostic pages, and result summaries to `coverage/browser/` for CI retention;
fixture projects and tool caches use owned scratch and are removed after their processes drain, including failed runs.
Default local evidence is retained under the native Workbench cache's `browser-evidence` directory. Completed runs,
including failures, follow `logs.max_age_days` and `logs.max_bytes`; explicit cache keeps protect investigations.
Browser artifacts have their own run manifest and producer lock, separate from text logs. Retention runs after browser
completion and during ordinary automatic maintenance. `workbench cache prune --browser` previews expired evidence; add
`--apply` to delete it, `--all` to use each project's retention policy, or `--json` for a structured plan and result.
Deletion rechecks ownership and policy under a lock. Live or uncertain producers, explicit keeps, unavailable projects,
and the newest eligible run remain protected. Interrupted runs recover only when the producer and registered children
are proven gone. Exported `--output` evidence remains caller-owned. `--keep-fixtures` deliberately preserves fixture
state and prints its location for debugging.

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
Guix image from the configured registry and fails if it cannot retrieve it. Build, verify, and publish these images
before pushing a recipe or dependency-pin change, using local preparation or the explicit native preparation workflow.
Routine check jobs never build them. The pre-push gate checks registry manifests for every prepared image required by
the outgoing revision's CI targets, including other Linux architectures. It does not pull layers, build images, or
accept a local-only image as proof of publication. Missing images and registry access failures block the push with the
affected profiles and references. Combined checks perform the same availability check in their online phase. Registry
inspection uses the Docker CLI and its configured credentials, without requiring a running Docker daemon. These checks
use the repository's own declarations and registry locations, including GitLab Container Registry or other OCI
registries; no prepared images are required when that repository declares none.

Preparation uses the checked-in Dev Container recipe. Its builder, architecture, recipe, and locked inputs determine the
tag; the realized image and registry digest identify the exact environment that was verified. Native recipes let the
supported distribution's package manager select current OS packages, including security updates, while language tools
and application dependencies retain their pins and locks. The Ubuntu bootstrap around Guix follows the same OS package
policy; its authenticated Guix channel remains pinned. Ubuntu-based native images and fallback Guix builders retain
their resolved OS package inventory at `/usr/local/share/workbench/os-packages.tsv`. Local native recipe builds refresh
the OS layer while retaining tool and dependency download caches. Existing images remain unchanged until explicitly
rebuilt, qualified, and published; a recipe tag can then identify a new digest. Native check caching includes the OS
package database, so host package changes invalidate prior evidence.

During local preparation, Workbench checks local images, then tries the configured registry. If retrieval fails,
including transport or authorization failures, it reports the cause and builds locally from the same pinned recipe.
Local preparation still needs its base images and dependency inputs available locally or downloadable. Retrieved images
must match the declared inputs and pass fresh offline verification; publication failures remain errors. Native gates
select no emulation. Explicit foreign preparation uses the selected target architecture, verifies fresh source offline
using configured binfmt, and records the verification host and emulation method. This supports ARM64 images on x64 hosts
and x64 images on ARM64 hosts. Emulated evidence does not establish native platform support; complete the configured
native CI matrix before publishing a Workbench release. `development prepare PROFILE --build` explicitly selects a local
recipe build for initial preparation or recipe verification; it bypasses local-image and registry reuse.

## Preparing and retaining project images

The reference's three builder profiles prepare all registered language roots. `offline.inputs` lists files/directories
that define image contents and environment closures; orchestration, verification, and cache handling are separate.
Optional `offline.paths` restricts which roots the profile supports. Recipes retain SDKs and dependency inputs, not
successful project build outputs. The native recipe installs verified tools; managed recipes retain their own builder
stores.

Without an explicit `offline.verify`, Workbench runs the shared preparation recipe in verification mode. It selects the
profile's roots independently of CI coverage, runs each root's `build` role, then its `smoke` role in one fresh checkout
with networking disabled and without host caches. All ten bundled language starters provide these roles. The shared
session retains build outputs through smoke execution. Their smoke commands execute the README console examples and
check the program's output. These are the same examples checked by the ordinary `docs` checks, with no separate image
test suite to maintain. Run a smoke check independently with `workbench check --path ROOT --role smoke`. Projects can
adapt their language definition or add smoke commands to `workbench/automation.toml`. Roots with entirely project-owned
checks must supply these roles themselves. An explicit `offline.verify` command replaces the shared verifier when the
application needs a different qualification workflow; it still must prove fresh offline build and execution.

Package-manifest identities normalize presentation, sort top-level keys and known unordered dependency maps, and omit
ordinary command scripts. Arrays and other nested maps retain their order, including conditional exports and imports.
Installation hooks retain the entire script table because hooks may invoke other scripts. Dependency declarations,
manager settings, platform constraints, and other manifest fields remain significant. Managed dependency metadata uses
the same identity rules, so command-only and formatting changes do not stale its declarations. Other inputs retain
exact-byte identities; arbitrary JSON files may be signed or consumed as bytes.

Workbench's portable Rust profiles select the existing prepared native image through `--image-profile native`. That
image includes distribution-managed musl development tools. The release helper acquires and checks the image, then gives
cross its immutable registry digest and the selected native Rust toolchain. Routine CI does not build a separate musl
image. A consuming project's standalone Rust recipe can still use its project-owned `Dockerfile.musl`, with current OS
packages selected during explicit preparation.

Native preparation installs verified tools, runs each included root's `acquire` role to fetch locked test and analysis
inputs without running those suites, then builds the root to fill its dependency stores. Bundled acquisition commands
use the selected native tools and verified downloads. Optional CI tool variants contribute their compatible SDKs;
projects need no CI matrix to select image roots. Full lint, unit, coverage, and browser suites remain in the configured
CI gate. Advisory queries remain fresh. Managed images acquire dependencies from their package definitions and use the
same offline build and smoke execution qualification. Image recipes remain project-owned, and prepared images remain
optional.

`offline.registry` names a project-owned OCI repository with an explicit registry host and no tag (for example,
`ghcr.io/owner/project` or `registry.example.com:5000/team/project`). Docker handles registry authentication; the
provided GitHub workflow authenticates to GHCR. Architecture and input hash supply the tag:

```sh
workbench development prepare native
workbench development publish native
workbench shell --profile native --workspace devcontainer
```

On a Linux x64 host with an ARM64 F-flag binfmt interpreter enabled, prepare and publish the ARM64 variant with:

```sh
workbench development prepare native --architecture arm64
workbench development publish native --architecture arm64
```

Use `--architecture x64` on Linux ARM64 hosts for the reverse direction. The same selection applies to `nix` and `guix`
profiles. Preparation already verifies offline; `development verify PROFILE --architecture TARGET` explicitly repeats
verification when needed. `--assemble-only` stops before verification and cannot establish an accepted image for
publication. Each architecture retains its own receipt and operation lock, so different architectures can prepare
concurrently. Shared maintenance and builder-store locks protect retention and shared package-manager state. Enable
binfmt on the Docker host before foreign execution. Its F flag keeps the emulator usable inside container and manager
namespaces; the registration must be restored after a host restart. Emulator dependencies require human review.

User-mode emulation cannot translate every kernel operation. In particular, running Nix itself under a foreign
architecture can fail when it installs its syscall filter, even when the required binary substitutes are available
([upstream issue](https://github.com/NixOS/nix/issues/5258)). The reference Nix and Guix preparation recipes keep the
package manager native and select the target architecture for package builders. When installed, the host manager and
store are reused; otherwise a native Docker manager owns persistent store volumes. Independent profiles such as Nix and
Guix can prepare concurrently. An installed Nix daemon must permit the target in `extra-platforms`; Workbench configures
this on its private Docker daemon. Local compilation cost also depends on project package variants: the reference Guix
GCC workaround changes the compiler graph and requires rebuilding its dependent Clang/LLDB packages on a fresh target
store.

Run `workbench development images` to see local preparation, registry availability, full image references, and
diagnostics in one table for the host architecture. Long references wrap to fit the terminal. In a terminal, select
profiles to prepare, then separately select prepared images to publish. Each selection includes Select all and Select
none; Esc stops the interaction. `--architecture` keeps the selected target through inspection and both operations.
Preparation may retrieve an existing registry image instead of building. Already prepared images skip preparation, and
already published images skip publication. Profiles without a configured registry can be prepared locally. Preparation
installs the locked Dev Container CLI when needed.

Use `workbench development images --list` for the status table without prompts, or `--json` for structured status.
`--require` also stays read-only and exits unsuccessfully if any selected image is unavailable in its configured
registry. Redirected output and CI never prompt. The explicit `prepare` and `publish` commands remain available for
automation; interactive preparation and publication require a Linux x64 or ARM64 host.

Pre-push groups unavailable images by missing publication or failed registry checks. The image status table shows
configured profile references; JSON diagnostics retain the exact failed destination references. Publishing an earlier
recipe does not satisfy a new recipe identity after locked inputs change; prepare and publish the current profiles
again. A registry outage does not establish that an image is missing.

Preparation and verification keep receipts in the local Workbench cache without changing the working checkout.
Publication first verifies fresh source builds and execution offline, then pushes the image and pulls its registry
digest to confirm the published identity.

Configured retention can prune owned local cached images, protecting active use and explicitly retained images. It
preserves images when ownership or replacement evidence is uncertain. Deleting published registry images remains
explicit; registry-pruning commands support GHCR versions and configured GitLab prepared-image tags. An old checkout
selects its own configuration hash and can rebuild a missing image locally. These images are internal to the project;
other projects prepare images from their own declarations.

The separate explicit `publication.yml` workflow prepares and publishes the six development images on native x64 and
ARM64 GitHub runners. It runs offline build and execution verification before publishing, then verifies the registry
digest. It does not wait for Checks: Checks needs these images first. Local preparation and offline verification may
instead use explicitly selected binfmt emulation in either direction. Go example containers are built and executed
locally without publishing disposable registry packages; the actual development images verify registry push/pull
behavior. Check jobs have read-only registry access and never publish. Workbench release archives use `release.yml`,
which requires successful Checks for the exact source revision. Credentials are supplied at invocation and never
included in preparation inputs or image layers.

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

Windows native CI also runs the `mvsc` profile for the C and C++ references. Compiler compatibility targets for `mvsc`
use Windows runners. The consuming-project integration suite automatically repeats the C/C++ journeys with `mvsc` on
Windows x64, covering initialization, adoption, hooks, failure/recovery, and mixed-language roots. Run that selection
explicitly with `node scripts/check-consumers.mjs --language c --language cpp --compiler mvsc`. All selected profiles
share one archive and versioned run report, with separate command logs; a failed profile does not suppress other
independent profiles.

Maintainer-only root checks declare `ci.toolchain = false` in `workbench/automation.toml`. They run under the declared
development pins on every configured OS, while alternate Node profiles retain the complete behavior suite and browser
checks. The selector applies only to the CI stage; ordinary commit checks and explicit role checks keep their scope.
Other consumers can select a named tool profile with `ci.toolchain = "PROFILE"`. Unspecified checks run on every
profile.
