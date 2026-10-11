# Development and release profiles

Profiles are project-owned declarations in [workbench/config.toml](../config.toml). They select an execution workspace
or a release recipe. Shared language definitions remain independently replaceable; profile declarations do not merge
with another project's declarations.

## Development selection

```sh
workbench development                         # Show profiles and mark the active choice
workbench development use                     # Choose interactively; Enter keeps the active choice
workbench development use nix-container        # Save an ignored local preference
workbench config set development.profile guix  # Equivalent local configuration operation
workbench shell --path examples/languages/go
workbench shell --profile nix-container --path examples/languages/go -- go test ./...
workbench checks run --profile native --path examples/languages/go
```

An omitted interactive selection presents the choices. Automation supplies a name. Selection writes
`workbench/local.toml`; it does not install tools or change CI or release profiles. Open a new shell to use a changed
selection. An explicit `--profile` or `--environment` overrides the local preference; they cannot be combined. Managed
shells stay bound to their builder and language root.

| Profile          | Builder                            | Workspace     | Host prerequisite                       |
| ---------------- | ---------------------------------- | ------------- | --------------------------------------- |
| `native`         | Native tool declarations           | Host          | Declared native tools                   |
| `nix`            | Locked flake                       | Host          | Nix                                     |
| `guix`           | Authenticated channel and manifest | Host          | Guix                                    |
| `container`      | Native tool declarations           | Dev Container | Docker and the locked Dev Container CLI |
| `nix-container`  | Locked flake                       | Dev Container | Docker and the locked Dev Container CLI |
| `guix-container` | Authenticated channel and manifest | Dev Container | Docker and the locked Dev Container CLI |

Each container profile points to its own standard `devcontainer.json`. The default remains
`.devcontainer/devcontainer.json`. An editor can open the selected configuration directly, and the upstream
`devcontainer` CLI remains usable. Workbench supplies profile selection and the existing check/shell adapters. Its
managed container profiles need neither Nix nor Guix installed on the host.

Use either a local `build` definition or a digest-pinned prebuilt `image` in that standard configuration. The reference
profiles build locally from pinned base images. Their bootstrap Node runs Workbench; the selected Nix/Guix environment
supplies language tools. Managed profiles reject Dev Container Features, including inherited image Features, so compiler
ownership stays with their builder; add workspace utilities in the image definition instead.

The Nix workspace uses a bootstrap closure from the Go example's existing flake lock. The Guix workspace uses Ubuntu
24.04's Guix package from signed Ubuntu repositories as its bootstrap, then authenticates the example's pinned channel.
The fresh 26.04 base did not supply that bootstrap package during local verification. No example lock or channel was
advanced.

Workspace mounts preserve the checkout. Checks run as ordinary workspace users while the Nix/Guix daemons run as root,
preserving host ownership of build files. Build storage remains in the selected Workbench cache. Container images,
builder stores, and Guix checkout caches have their own lifecycle; Docker image/volume cleanup is explicit. The example
Guix workspace allows nested namespaces through its declared seccomp and system-path exceptions. Review container
settings before using a profile with sensitive host mounts. Its cold pinned runtime build took approximately 20 minutes
locally. Reopening an existing workspace retains its store and channel cache; rebuilding an image needs retained builder
state or a prepared image to avoid repeating that work.

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

The example profiles target Linux x64. A foreign platform fails before building; preparation does not automatically
emulate another architecture. Use a builder native to the declared platform. The provided reference recipes are:

| Builder | Formats                                                                                                  | Verification                                                        |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Native  | Go executable directory                                                                                  | Copied executable outside the checkout                              |
| Nix     | Exported closure, portable static tarball, Docker archive                                                | Fresh store import or offline container execution                   |
| Guix    | Relocatable (`-R`) and really relocatable (`-RR`) tarballs, Docker archive, Squashfs, Apptainer workflow | Offline container execution without the application's builder store |

Nix recipes use the existing pinned Nix Docker adapter; a host Nix installation can use the recipe's `nix` argument.
Guix recipes use the host Guix daemon and authenticated `channels.scm`. Preparation may fetch verified builder inputs.
Behavioral verification runs offline after its runtime is acquired. Application release images contain runtime closures;
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

Outputs are accepted by an atomic directory rename into `dist/releases/NAME` only after verification and unchanged
artifact/source checks pass. Failed staging and verification copies are removed. Existing accepted outputs are
preserved; move them explicitly before rebuilding a profile. Independent selected profiles can finish even when another
fails, with an aggregate failure reported.

`workbench-release.json` is reserved for the verification receipt. It records profile configuration, source file
identities and Git revision/dirty state, locked builder inputs, platform, artifact sizes and SHA-256 identities, and
verification/emulation results. This is local preparation evidence. It does not create a `REL` record, a Git tag, or a
registry publication. Publishing and testing GitHub Container Registry remain separate reviewed work.

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

## Container workspaces

Dev Containers are optional. Install Docker, then the locked host CLI with `workbench tools install --devcontainer`. Use
`workbench shell --environment devcontainer`, `make build ENVIRONMENT=devcontainer`, or select it in
`workbench/local.toml`. The checked-in `.devcontainer/` definition builds from a digest-pinned image, adds the declared
OS prerequisites, and installs the same native tool pins on creation; it works with the standard Dev Container CLI and
compatible editors. A consuming project can copy the `.devcontainer/` directory to its root and adapt it; normal setup
does not introduce containers. Automated container coverage currently targets Linux x64. Other host/container
combinations need separate architecture and execution verification; these recipes do not force an emulated platform. For
Workbench container commands on Windows, use WSL; native Windows checks remain supported.

The workspace is bind-mounted, so outputs and edits remain in the checkout; the container persists between commands.
Rebuilding it discards tools installed inside it, which setup reinstalls. Workbench mounts this checkout's build cache;
an existing container without that mount must be rebuilt after active work finishes. After changing tool pins, run
`workbench tools install --environment devcontainer` to refresh them in the existing container. Local environment
selection and CI coverage remain independent. Container checks can run from the host through benchd; an editor or
interactive container without benchctl does not provide host scheduling automatically.

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

## Prepared offline profiles

Offline development is opt-in. Workbench provides `native-offline`, `nix-offline`, and `guix-offline`, each
demonstrating the Go reference. Install Docker and the locked Dev Container CLI; Nix and Guix need not be installed on
the host:

```sh
workbench tools install --devcontainer
workbench development prepare native-offline
workbench development verify native-offline
workbench development use native-offline
workbench shell --path examples/languages/go -- go test ./...
```

Preparation builds the standard Dev Container definition online, then mounts a separate source snapshot into the
resulting immutable image with `--network=none`. Verification has no host dependency-cache mounts or installed project
outputs; it compiles and tests current source. Native installation uses Workbench's verified installer. Nix retains
locked flake sources and the realized development closure. Guix retains its authenticated time-machine profile and
manifest closure. All three retain project dependency downloads. Advisory checks requiring live services remain online
operations; an offline build does not claim fresh vulnerability information.

The Guix recipes bound file descriptors during image builds and daemon startup. Older bootstrap daemons otherwise
scan Docker's potentially enormous inherited limit when starting children, adding minutes to each build step.

Each offline development profile adds a project-owned table:

```toml
[development.profiles.offline]
path = "app"
inputs = [".devcontainer/offline", "app/go.mod", "app/go.sum", "app/.go-version"]
verify = ["node", "scripts/offline.mjs", "verify", "native"]
```

`path` names a registered root; `inputs` lists preparation recipes, pins, locks, and environment definitions. Workbench
always includes the profile, its container JSON, and any shared Workbench distribution pin. Declare every other
preparation input explicitly, including copied helpers. Input directories follow the Git snapshot and exclude ignored
caches; explicitly listed files must be included in that snapshot. The example configuration includes Nix/Guix definitions
and the native acquisition authority. Ordinary source edits reuse the image and are verified afresh; changing a declared input
requires preparation again. Preparation does not change the active development profile. Failure preserves the previous
receipt.

The verification command runs from `path` inside the fresh source snapshot. `{workbench}` expands to that snapshot's
Workbench distribution when the command needs its CLI or a shipped helper.

Offline profiles use one image and a literal `workspaceFolder`. Prepare dependencies in the Dockerfile rather than
lifecycle commands. Additional mounts, Compose, and network overrides are rejected. Managed profiles reject compiler
Features. The Guix recipe declares `WORKBENCH_GUIX_TIME_MACHINE_PROFILE` for its retained authenticated profile; offline
execution uses that profile without contacting channel repositories. Images must match the native Linux architecture; no
emulation is selected. Linux x64 is verified locally; Linux ARM64 requires native verification. On Windows use WSL 2.

Workbench records accepted image IDs, input hashes, verification time, and any published digest under the platform
user-cache `offline-profiles` directory. Docker retains image bytes separately. Deleting a receipt requires preparing
again; deleting Docker images requires recreating or pulling them. Workbench never prunes unrelated Docker images or
containers. Preparation and verification remove their own temporary workspaces and verification containers. Workbench
disables automatic UID rewriting for accepted images; choose a workspace user whose permissions allow writes to the
checkout. Opening an offline profile retains the usual working-checkout mount and container session, with networking
disabled and no host dependency-cache mounts.

### Publish a prepared image to GHCR

Authenticate with Docker's normal credential lookup, then explicitly select the destination:

```sh
workbench development publish native-offline --image ghcr.io/OWNER/PROJECT-dev:TAG
```

Use lowercase owner and repository names. The command first repeats local offline verification, pushes the selected
image, pulls its registry digest, checks that it is the prepared image, and repeats the offline build against the pulled
reference. It prints and records the immutable `ghcr.io/...@sha256:...` reference. Authentication is external; Workbench
neither stores nor prints registry tokens. Existing local destination tags are preserved by rejecting their reuse. A
failed post-push verification cannot retract a registry upload; the command reports failure and does not record the
image as verified publication. Tags can be updated by the registry; consumers should pin the returned digest.

A consumer can use that digest as the `image` in its standard Dev Container JSON and configure its own offline profile.
`development prepare` pulls the pinned image and verifies it against that consumer's current source and declared
command, without requiring the builder on its host. Live GHCR credentials and permissions require hosted verification;
local tests exercise publication ordering and failures without uploading images.

The explicit registry-verification workflow covers native, Nix, and Guix offline development images alongside release
images. It requires successful complete Checks for the same revision, uses a distinct tag for each workflow attempt, and
retains publication receipts. It is separate from ordinary push and pull-request checks.
