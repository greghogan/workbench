# Native tools, caches, and cleanup

[Workbench overview](../README.md). Commands assume your project root; `workbench` denotes the executable in your pinned
distribution.

Install the declared native tools without Guix, Nix, or a universal version manager:

```sh
./bin/workbench tools                        # Pins and installation locations
./bin/workbench tools install                # All registered roots
./bin/workbench tools install --path examples/languages/rust
make build
```

Bootstrap with a Node version satisfying `package.json`'s `engines.node`, Git, Bash, and the system archive tools (`tar`
and `xz` on POSIX; Windows includes `tar.exe` and needs Git Bash). Workbench downloads verified upstream artifacts for
Node, Go, LLVM, and standalone tools; Rust uses rustup and Python uses pinned uv. GCC uses stripped, relocatable Linux
x64/ARM64 packages from [gcc-releases](https://github.com/foss-mirror/gcc-releases/releases), verified against recorded
SHA-256 values and the publisher's workflow attestation. These packages require glibc 2.28 or newer, zlib, and the host
libc development SDK; the installer rejects older or unidentified libc before acquisition. Their producer already
filters the package; Workbench streams and validates the complete SDK and records its integrity manifest. Native
development, hosted CI, and local rehearsal acquire the same GCC packages. Workbench installs rustup when absent and
each Rust root's declared components, including rust-analyzer. Rust roots may also declare `rust-toolchain-miri.toml`
for a separately pinned Miri nightly; see the Rust reference for its explicit check role. GitHub API downloads use
`GH_TOKEN` or `GITHUB_TOKEN` when supplied, solely for `api.github.com`; redirects to asset hosts do not receive those
credentials. Signature and attestation verification still applies. Native Dev Container preparation forwards `GH_TOKEN`
as a temporary build secret when supplied, allowing authenticated proof downloads without retaining the token in image
layers. Obtain it from your credential provider before preparation to avoid GitHub's anonymous API rate limit.

The Rust reference selects rustup's `minimal` profile with Clippy, rustfmt, rust-analyzer, rust-src, and matching
`llvm-tools-preview` coverage tools. Preserve these declared components during updates even when rustup shares an
installation across roots. `rust-toolchain-miri.toml` separately supplies the dated nightly's Miri and standard-library
sources. Cargo profiles own Rust LTO; GCC's `full` LTO and LLVM's `thin` LTO are separate C/C++ selections described in
the [language guide](languages.md).

Installations do not replace system packages or change the parent shell's `PATH`. Checks and `workbench shell` select
the installed pins; ordinary checks never install or repair compiler versions. Package setup still uses the configured
dependency locks.

Package-manager bootstrap uses each ecosystem's verified installer. Maven's reference pins dependencies and plugins in
the POM and commits an artifact checksum allowlist; Maven verifies resolved bytes, including cached artifacts, against
it. RubyGems installs the lockfile's Bundler version from a verified local gem. Composer's pinned PHAR is verified with
its recorded digest and upstream signature; the project-owned Composer plugin checks dependency distribution archives
against reviewed SHA-256 values before extraction. Ordinary checks never learn new hashes. Explicit dependency updates
regenerate the corresponding lock/checksum data for review. See the [Java](../examples/languages/java/README.md),
[Ruby](../examples/languages/ruby/README.md), and [PHP](../examples/languages/php/README.md) references for the
commands.

Native Ruby source builds use authenticated release sources and private staging; Windows uses signed RubyInstaller
archives. PHP uses signed sources for Unix CLI builds and official Windows x64 ZIPs. The currently pinned Ruby gems, PHP
Windows ZIPs, and Xdebug sources have explicit proof-absence metadata where publishers provide no applicable signatures
or attestations. The recorded digests remain mandatory. Native extension caches are specific to their runtime and ABI;
source builds require the host development SDK.

Bundled artifact metadata covers Linux x64/arm64, Windows x64, and macOS arm64 for the declared native tooling. Windows
ARM64 is unsupported. Compilers, runtimes, and installed helpers use native architecture artifacts. GCC installation and
compatibility coverage support Linux x64 and arm64 only; Clang supports every declared native platform. This policy is
documented for both languages in [ADR-12](../workbench/decisions/ADR-12.md). Unlisted pins require reviewed additions to
`scripts/native-assets.json` (LLVM uses `scripts/llvm-assets.json`) or matching tools supplied on `PATH`. Pins remain
authoritative in each root; artifact metadata records acquisition URLs, SHA-256 digests, upstream proofs, and explicit
proof absence. [Pinned trust material](../scripts/keys/README.md) records the verification authorities. OpenPGP
verification requires GnuPG; Linux runtime package extraction also requires binutils and XZ utilities.

Node, Go, Maven, Ruby source, and Windows PHP downloads have official alternate endpoints where verified; these may
share upstream infrastructure and do not guarantee independent availability. GitHub-only artifacts such as LLVM and GCC
retain their declared upstream release source. Python, Rust, and project dependencies keep their package managers'
source selection rather than adding a separate Workbench mirror policy.

Artifact metadata may declare ordered `backupUrls` for the same pinned bytes, including separate backups for signed
checksum catalogs and detached signatures. Workbench tries a backup when a source is missing, rate-limited, unavailable,
or unreachable after its connection retries, using the same overall deadline. It reports the fallback and still requires
the original checksum and upstream authentication. Authentication failures, invalid proofs, checksum failures, and
interrupted body transfers stop acquisition. Backups never select another version or bypass a managed environment's
declared local sources. Backup locations appear in provenance but do not change installation identity: verified bytes,
required proofs, extraction policy, and build recipes remain authoritative.

Bundle builds automatically prune `scripts/native-assets.json` of tool/version entries no longer referenced by native
pins, compiler support configuration, bootstrap declarations, or implicit runtime dependencies. Every supported platform
entry for a retained version is preserved. The bundle gate rejects obsolete entries without modifying files; missing
required metadata fails before pruning. This maintains the shipped inventory and does not delete installed toolchains.
Python compatibility CI reuses the authenticated uv artifact installer with
`workbench tools install --path ROOT --tool uv`; uv continues to own Python acquisition and locked Python dependencies.

`--tool NAME` installs the selected package and its required package dependencies. It does not require unrelated
development tools. Installation then probes the selected executables using explicit package definitions: executable
paths, harmless arguments, and version-matching rules. These are shared with full toolchain checks. A package may supply
several executables (LLVM), or only libraries (the private LLVM runtime); its package name does not imply an executable
name. New executable tool packages need declared probes. Probes use the verified installation directly, allowing
contained upstream executable symlinks, and report execution or version failures separately from acquisition failures.

`--exclude-tool NAME` omits a tool from installation or inspection and can be repeated. It cannot be combined with
`--tool`; toolchain checks still enforce their required tools. Ordinary CI excludes the optional Miri installation; full
development setup includes it, and `--tool miri` installs it explicitly.

The bootstrap supplies launchers for nested package scripts too, preserving the selected package manager and Node
runtime without requiring a global package-manager installation.

CI caches package-manager bootstrap installations separately from native tools and project dependencies. Native cache
keys cover the selected artifacts, their authentication and extraction policy, trust material, and acquisition code.
Unused inventory entries do not invalidate those caches; bootstrap implementation changes do not invalidate native tool
caches. LLVM and GCC caches retain only the selected installation directories.

Workbench-managed toolchains live in `toolchains/` below the platform cache directory: `$XDG_CACHE_HOME/workbench`
(default `~/.cache/workbench`), `~/Library/Caches/workbench`, or `%LOCALAPPDATA%/workbench/cache`. Downloads share this
cache root. Absolute `WORKBENCH_CACHE_HOME` overrides it; `WORKBENCH_DATA_HOME` controls durable user records
separately. Rustup and uv retain their own documented storage locations and configuration; `rustup show home` and
`uv python dir` report them. CI explicitly places uv-managed Python installations in its cache too. Project cleanup
preserves shared toolchains. Clearing the toolchain cache requires `workbench tools install` again; network access may
be needed. Ordinary checks never download replacements. Obsolete toolchain versions are not automatically pruned.
Existing installations in the former data directory are not moved automatically; move them explicitly into the cache's
`toolchains/` directory or reinstall, preserving any destination already present.

`workbench tools` reports expected installation paths and receipt status. This inspection does not rehash installed
files; explicit installation verifies filtered cache contents before reuse. Filtered LLVM installation streams the
authenticated archive without retaining it. When selecting archive inputs, prefer suitable upstream Zstandard archives.
The following sizes are decimal approximations of byte limits. LLVM 23's pinned Zstandard artifacts require an explicit
1.07 GB decompression-window cap; the default for other filtered artifacts remains 134 MB. Private staging uses the
installation filesystem; failures remove owned staging, and successful installations activate by atomic rename. Ordinary
tar downloads pass a bounded streaming preflight before platform extraction; ZIP files use lazy directory iteration and
bounded file streams. The default limits are 4.29 GB incoming, 25.8 GB decompressed, 4.29 GB retained, 1.07 GB per file,
65.5 kB per metadata entry, 100,000 entries, and a 30-minute acquisition or extraction deadline. Source checksums remain
mandatory independently of these limits. `workbench tools --json` exposes expected installation paths and acquisition
policy identities without downloading or rehashing tools. Filtered manifests bind retained content to the source,
filter, resource limits, proof identities, and trust digests. Changing those inputs selects a distinct filtered
installation and CI cache. Local integrity hashes do not replace publisher authentication.

Direct native extraction validates paths, entry types, duplicates, and links before their filesystem effects. Writes
cannot traverse links, and retained link targets must resolve inside the installation. Filtering does not bound archive
expansion, and private staging does not sandbox parsers; acquisition and extraction enforce their limits independently
of retained contents.

For filtered archives, incoming and retained content hashes are computed while streaming. Integrity manifests cover
retained paths, contents, permissions, and link targets. Compressed filtered-cache output is hashed as written; packing
preserves the integrity manifest and upstream proof bytes needed for offline revalidation against the selected trust and
artifact identity.

On Linux x64 and ARM64, LLVM's ICU 70 runtime is installed privately in the same toolchain cache. LLVM 21 and 22 also
need the older libxml2 linker ABI, acquired from a pinned Ubuntu snapshot. These packages are verified through the
signed release catalog, pinned package index, and exact package digest. Debian runtime extraction retains the declared
library directory and copyright notices, excluding documentation links into separate packages. Native selection adds
their private library directories for LLVM. The local CI image authenticates its initial Node runtime before activation
and uses the same native tool installer afterward.

LLVM supplies the compiler and its tools, not a platform SDK. Linux needs system libc/C++ development headers and
libraries (for example, `gcc-c++` and `glibc-devel` on Amazon Linux); macOS needs Xcode Command Line Tools; Windows
needs Visual Studio C++ Build Tools and the Windows SDK, with a developer environment initialized. Native selection
removes inherited Guix/Nix header paths when using installed LLVM. Select Guix/Nix explicitly when their SDK is
intended.

GCC packages use the current Linux host's libc SDK and include multiarch search support for Debian and Ubuntu. Native
selection exposes the package's runtime libraries for executables built with that compiler.

The C/C++ references use vcpkg manifest mode. `.vcpkg-version` pins the tool checkout; `vcpkg-configuration.json` pins
the builtin registry baseline, available in that checkout for offline use. `vcpkg.json` declares dependencies. The C CLI
uses yyjson and C++ uses fmt. vcpkg additionally needs curl, zip, pkg-config, and the usual POSIX text utilities. Builds
acquire the pinned tool in the Workbench toolchain cache and use the selected compiler through a generated CMake
triplet. Sources use the Workbench download cache (or `VCPKG_DOWNLOADS`); build trees and installed libraries use the
root's selected build cache. vcpkg's standard binary cache is shared, keyed by compiler, triplet, recipes, and declared
ABI-relevant environment. `VCPKG_BINARY_SOURCES` can configure a remote cache. Baselines set version floors; use
explicit overrides when a dependency needs an exact exception. The C/C++ dependency-refresh skills cover both
declarations.

## Terminal presentation

Workbench supports a personal plain presentation preference for stable output and line-oriented interaction. Select it
for one command with `workbench --plain COMMAND` or `workbench COMMAND --plain`, for a shell session or Git hooks with
`WORKBENCH_PLAIN=1`, or persist it across projects with `workbench config set terminal.plain true`. This setting belongs
to the user, not tracked project configuration. Restore the saved default with `workbench config unset terminal.plain`.

The command flag overrides the environment, which overrides the saved preference. Use `--no-plain` to override an
enabled preference for one command. `WORKBENCH_PLAIN` accepts `1`/`true` and `0`/`false`; unset or empty uses the saved
preference. Plain presentation replaces screen redraws and spinners with stable messages, displays complete labels and
labeled table values, and uses numbered selections accepting ordinary lines of input. Enter continues; `cancel` cancels.
Deletion still requires explicit confirmation, and protected-record approval still requires a human in a terminal. Plain
review displays an uncolored diff without a pager.

Independently, a nonempty `NO_COLOR` suppresses Workbench's added color, including review diffs. It does not change
menus or progress presentation. Plain presentation also suppresses color. Existing redirected-output and dumb-terminal
fallbacks remain available; `NO_COLOR` alone does not select them. Presentation preferences do not establish
accessibility conformance; terminal and assistive-technology behavior still needs assessment.

## Build and dependency storage

### Platform locations

Workbench follows [ADR-I](../workbench/decisions/ADR-0I.md). Linux uses the
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) for configuration, data,
state/logs, cache, and runtime files, honoring defaults, absolute-path rules, lookup precedence, and runtime
protections. macOS uses `Library/Application Support`, `Library/Caches`, and `Library/Logs` under platform-resolved
locations; native preferences use the preferences API rather than arbitrary files in `Library/Preferences`. Platform
lookup must respect sandbox containers. See Apple's
[Library directory guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html).
Windows uses [Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid), defaulting to
`LocalAppData` with a separate cache directory. `RoamingAppData` is reserved for deliberately roaming settings and data;
packaged applications use their application-storage APIs. Never derive locations from an assumed drive or profile path.

macOS and Windows use protected native temporary-directory and IPC facilities. Temporary storage cannot replace durable
state. XDG on these platforms is an explicit portable mode, not the default. Document service-specific locations and
explicit user roots separately; changing a preference does not migrate existing files.

### Test workers

The root Vitest suite uses all CPUs available to its job, with process isolation. Standalone Workbench runners and
direct test invocations default to the host's available CPU count. An explicit `execution.cpus_per_job` or
`WORKBENCH_CPUS` request takes precedence within the inherited `WORKBENCH_CPU_BUDGET`; parallel check groups and
multi-target local CI supply each job's assigned limit. No fixed worker cap applies. For example,
`WORKBENCH_CPUS=8 make test ROOT=.` allocates up to eight CPUs on a sufficiently large host. Test timing and coverage
requirements remain unchanged.

An automatic gate with explicit setup overlap reserves part of its CPU budget for other roots. On a 32-CPU host the
root's tests receive 24 workers while up to two four-CPU example groups run alongside them. A focused root test run still
receives its full standalone allocation. [Execution budgets](execution.md) describes overrides and smaller hosts.

Long integration scenarios are grouped into independently scheduled test files for installation snapshots, cache
inputs, gate recovery, review policy, CI targets, and command entry points. Shared fixture helpers create writable
state separately for each test; process isolation also keeps environment overrides and mocks local to each suite.

Execution settings are user preferences; Git-ignored `workbench/local.toml` can override them for one checkout.
`WORKBENCH_CPUS` and `WORKBENCH_MAX_JOBS` take precedence for an invocation. They are not tracked project options.

### Cleanup and external storage

`make clean` removes build outputs and test/tool caches from Workbench and all language references. `make distclean`
also removes dependency installations. Each reference supports the same targets from its own directory. Cleanup removes
this checkout/root's marked build directories across environments and toolchain revisions. Both preserve the checked-in
bundle, source files, lockfiles, dependency download caches, installed toolchains, unrelated Cargo targets, and Nix/Guix
stores. Gates sharing a checkout wait for the active gate, including configured cleanup runs. Cleanup still refuses
to remove a root's build state while another operation owns it.

Cleanup executes configured commands on the working checkout, without toolchain probes, dependency setup, or managed
containers. `make release ROOT=.` prepares `dist/workbench`, a runnable copy excluding local settings, dependencies, and
generated caches. All ten language references prepare release artifacts under the selected distribution directory,
defaulting to `dist/`. Rust selects executable artifacts from Cargo's build report.

Build outputs and dependency installations stay in gitignored project directories by default: Cargo `target/`,
TypeScript `build/`, C/C++ and Go `build/`, Node `node_modules`, and Python `.venv`. Package-manager download caches
retain their native locations in local storage mode. Release artifacts use `dist/` locally or `dist/` within the owning
external build-cache generation. CI reports remain in `coverage/` in either mode. Coverage intermediates use the
selected build storage. Workbench removes its raw V8 dumps and merge inputs after processing, including on failure;
`coverage/` retains the test results and final reports.

Prepared release artifacts are regenerable products, including after their publication elsewhere. External storage
selection applies to them alongside other build products; `workbench cache` includes their size under builds.
`make clean` and cache pruning remove them, while `make distclean` additionally removes project dependencies.
Preparation is explicit through `make release` or `workbench release prepare`; full CI also runs configured release
preparation and verification without publishing. Ordinary commit gates do not prepare releases.

Cache inspection groups check logs and successful gate results with their owning checkout under `CHECKS`. Normal pruning
removes both along with build products; `--dependencies` additionally removes installed dependencies. Pruning refuses
active runs and preserves directories whose ownership cannot be established.

`workbench paths` reports the selected root's `WORKBENCH_DIST_DIR`; pass `--toolchain NAME` when inspecting a named
compiler/runtime profile. Named release profiles use the checkout root's generation and report their exact artifact
paths through `workbench release prepare --json`. Recipes may use `WORKBENCH_RELEASE_OUTPUT` to select a specific
staging directory; otherwise adapters use `WORKBENCH_DIST_DIR`, then fall back to project-local `dist/` when running
independently. Changing storage preference leaves existing artifacts in their previous locations; regeneration and
cleanup are explicit.

For network checkouts or a separate build disk, opt in once in **global user configuration**:

```sh
workbench config
workbench config set storage.external true
workbench config get storage.external
# Optional: choose a different external storage root.
workbench config set storage.root /mnt/fast/workbench
workbench config unset storage.root
```

`workbench config` shows global defaults/preferences, human-managed project options, and ignored local overrides in
separate `OPTION | VALUE` tables for each scope, with their file paths. Long text wraps and large arrays and tables show
item or field counts; `workbench config get OPTION` prints the full value. Files that do not yet exist are marked.
Agent-managed `automation.toml` is separate. `<unset>` means that scope makes no declaration. `get` prints the
configured value, including an applicable local override; `--scope global`, `--scope project`, or `--scope local`
inspects that file alone. Outside a project, inspection shows global options without initializing a project.

`set` infers global scope for storage settings and project scope for project options; use `--scope local` to override
storage preferences or `checks.environment` in ignored `workbench/local.toml`. Local storage settings override global
preferences; tracked project configuration cannot specify machine storage. `unset` removes an optional declaration;
required project fields must be set explicitly. Values are validated before saving. Arrays use TOML syntax, for example
`workbench config set ci.operating_systems '["linux", "macos"]'`. Inspection creates no files. Unknown options, invalid
values, and options in the wrong scope are errors. The global `config.toml` is located at:

| Platform | Global configuration                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/workbench/config.toml`, defaulting to `~/.config/workbench/config.toml` |
| macOS    | `~/Library/Application Support/workbench/config.toml`                                     |
| Windows  | `%LOCALAPPDATA%/workbench/config.toml`                                                    |

`WORKBENCH_CONFIG_HOME` overrides the Workbench configuration directory and must be absolute. The opt-in file contains:

```toml
[storage]
external = true
# root = "/mnt/fast/workbench"
```

External storage defaults to `$XDG_CACHE_HOME/workbench` (or `~/.cache/workbench`) on Linux,
`~/Library/Caches/workbench` on macOS, and `%LOCALAPPDATA%/workbench/cache` on Windows. `storage.root` overrides that
location for builds, dependency installations, and the shared pnpm package store; tool installations and other download
caches are separate. The root must be outside the checkout. Ignored local storage overrides take precedence over global
settings. Separate namespaces identify canonical checkouts (including worktrees), language roots, environments,
toolchain/lock inputs, and build modes.

`workbench paths --path examples/languages/rust` prints the selected locations without creating them. `--shell` prepares
storage and prints shell exports; `--direnv` also prints watches for personal/project settings and the tool inputs used
in build identity. The two output modes are mutually exclusive. Both export paths only and do not select or install
tools. Language-specific exports apply only to languages registered at the selected root; nested examples do not add
their controls to the repository root. Languages sharing one root receive their combined controls. Checks and
`workbench shell` use the same storage controls.

[Opt-in direnv setup](adoption.md#optional-direnv-integration) generates hooks per build root so interactive commands
receive the matching paths without loading another root's environment. Common shell settings can be shared explicitly;
each root loads its own `.envrc.local`. Existing personal settings are preserved. Direnv watches changes to storage
preferences and tool inputs; an explicit Workbench shell retains its storage selection until reopened. Use the matching
Workbench shell for managed environments. Plain commands outside a configured environment retain their native defaults.

The project-owned `.pnpmfile.cjs` starter uses pnpm's `updateConfig` hook to apply these storage settings before direct
`pnpm add`, `pnpm update`, and `pnpm install` commands write packages. Keep this file when copying a TypeScript,
JavaScript, or React example into an integrated project. It uses the pinned Workbench executable, preserves paths
exported by managed sessions, and fails if integration or storage configuration is invalid. Without Workbench
integration, it leaves pnpm's defaults intact. Local storage remains available through `storage.external = false`.

The hook prevents accidental checkout-local installations; explicitly ignoring or replacing it bypasses that protection.
Existing adopted projects copy the starter and compose its `updateConfig` hook with any existing pnpm hooks rather than
overwriting them. pnpm records the hook's checksum in its lockfile; after adding or changing the hook, run
`pnpm install --lockfile-only --no-frozen-lockfile` and review the lockfile change before resuming frozen installs. A
project without the hook must run dependency-changing commands inside its matching Workbench shell.
`workbench check --role setup --path ROOT` restores the configured layout from the existing lockfile and removes a
previous local virtual store only after successful installation.

| Language   | External storage control                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust       | `CARGO_TARGET_DIR`; ordinary `cargo clean` removes the selected target.                                                                                                         |
| C/C++      | CMake build directories for each mode, including vcpkg output.                                                                                                                  |
| Go         | Explicit `go build -o`; Go's shared compilation and module caches retain native defaults.                                                                                       |
| TypeScript | Staged compiler output preserves package metadata and Node resolution. pnpm's per-root virtual store is external; local `node_modules` contains links and small metadata files. |
| JavaScript | Source-preserving staging retains package boundaries and Node resolution; pnpm storage follows the TypeScript layout.                                                           |
| Ruby       | Bundler installs native gems under the selected runtime ABI in external dependencies; verified bootstrap gems and shared archive downloads use external caches.                 |
| PHP        | Composer keeps application and tool installations separate under external dependencies; archive downloads and ABI-specific Xdebug builds are cached externally.                 |
| Java       | Maven compiles and packages in an isolated build directory; its shared repository stays under `<storage.root>/downloads/maven` and verifies the committed SHA-256 index.        |
| Python     | `UV_PROJECT_ENVIRONMENT` selects an external environment; setup maintains a `.venv` link for editors. Bytecode, check caches, and package-build intermediates are external too. |

In external storage mode, pnpm's shared package store lives at `<storage.root>/downloads/pnpm`; with the default Linux
location, this is `~/.cache/workbench/downloads/pnpm`. `PNPM_CONFIG_STORE_DIR` selects it for Workbench commands and
shells. Nix, Guix, and Dev Container execution expose the same cache where external storage is enabled. Project virtual
stores remain separate under `<storage.root>/dependencies`. Keeping both on the same filesystem allows pnpm to share
package files using hard links instead of copying between filesystems. `clean` and `distclean` preserve the shared
store; use `pnpm store prune` from the configured shell for explicit cache maintenance. Existing stores remain untouched
when changing storage preferences, preserving caches used by other projects.

Setup installs from existing locks at the new locations before replacing the local Python environment or removing the
former local pnpm virtual store. Python environments are recreated at their final paths because scripts embed absolute
paths. Turning the setting off and rerunning setup restores local installations. External Node dependencies require
pnpm's isolated linker; Python uses uv. Editable Python metadata may remain beside source.

`make clean` removes owned build products and reports while preserving dependencies. `make distclean` also removes the
selected root's dependency installations across environments. Shared download caches and installed tools are preserved.
Native tools retain their own locking; avoid cleanup during direct tool commands. Previous custom storage roots remain
untouched until selected again for cleanup.

### Inspect and prune caches

```sh
workbench cache                         # This checkout and shared Tools
workbench cache --all                   # All checkouts and Tools
workbench cache --checkout /path/to/project  # One checkout, including a removed checkout
workbench cache --checkout tools        # Shared Tools only
workbench cache --checkout images       # Locally prepared Docker images
workbench cache --registry              # Published GHCR versions for this project
workbench cache --json                  # Ownership, paths, versions, and protection reasons
workbench cache prune                   # Select projects and confirm; preview outside a terminal
workbench cache prune --dependencies    # Also select installed project dependencies
workbench cache prune --checkout tools  # Select and confirm shared-tool cleanup
workbench cache prune --checkout images # Select local images; preserves GHCR copies
workbench cache prune --registry        # Explicitly select GHCR deletion; preserves local images
workbench cache prune --all --apply     # Delete all preview candidates, including unprotected shared tools
```

The table treats shared installations as a virtual **Tools** project, with language groups as subprojects. C/C++ tools
share a group; Node covers JavaScript and TypeScript, and common helpers appear under `build-tools`. Totals use the same
layout as checkout caches. JSON includes individual versions, installation identities, paths, and protection reasons.
Tools always use their manager's installation location, independently of project build-storage preferences.

Workbench-owned prepared images appear as a separate **Images** group, initially unchecked in general cleanup.
Assemblies whose verification failed are included for cleanup, and availability distinguishes them from verified images.
Images attached to any Docker container, or covered by an active preparation lock, are unavailable for removal.
Workbench rechecks ownership and container references before deleting a local image tag without force. This includes
stopped containers; no Workbench option overrides that protection. Inspect them with `docker ps -a`, remove the
containers you no longer need, and rerun cleanup. `docker container prune` removes all stopped containers, including
those unrelated to Workbench, so review them first. The ignored local catalog retains its history, including published
digests, after deletion. Filesystem estimates, owned builder-volume estimates, and logical image sizes are reported
separately. Image-tag deletion does not promise a byte saving: Docker may share layers across images and retain
build-cache references. Confirmation lists image tags separately from filesystem and builder-volume estimates. Workbench
deletes only its owned image tags and builder volumes; `docker system df` shows Docker's remaining usage. `--registry`
deletes published GHCR versions and does not make local cleanup more aggressive.

Prepared-image recipe builds and local CI image assembly use a dedicated BuildKit builder per checkout, Docker engine,
and pinned BuildKit version. Its persistent volume appears in **Container builders**, alongside managed Nix/Guix stores.
BuildKit state and images loaded into Docker can retain separate copies of layers. Workbench uses a private Buildx
configuration and leaves your selected builder unchanged. Docker Buildx with the `docker-container` driver is required;
the pinned BuildKit image is pulled on first use.

Deleting a BuildKit entry stops and removes only its owned daemon container and state volume, including its build cache
and cache mounts. Active Workbench builds, changed resource identities, and other containers using that volume prevent
deletion. Failed or interrupted setup retains an ownership receipt for recovery. Removing the builder does not remove
prepared images, and removing image tags does not remove builder cache. Labeling imported images and materializing Guix
account files use a temporary, never-started Docker container, avoiding any shared build cache. Editor-managed and
ordinary unprepared Dev Container workspace builds retain the upstream CLI's Docker behavior. Old shared/default Docker
build cache remains outside Workbench's ownership and is never pruned by Workbench.

`--registry` selects GHCR versions instead of local cleanup. It uses the GitHub CLI's authentication: inventory needs
`read:packages`; deletion also needs `delete:packages` and package administrator access. Docker login continues to
control normal image pulls and pushes. Registry cleanup offers only Workbench's prepared-image tags and preserves
versions with unrelated tags. It rechecks the selected versions before deletion, does not infer supersession, and never
expires images automatically. Review the selection for older checkouts still used by other developers. GHCR does not
provide image sizes in this inventory. Other registries support availability checks, pulls, and pushes; their deletion
APIs are not implemented.

Outside a configured project, inspection and pruning default to all checkouts and Tools. In a terminal, the selector
separates **Projects** from **Shared tools**, with Select all/none and a deletion confirmation. Tools shows removable
size and count separately from pinned size; fully pinned Tools remains visible but disabled. Selecting or deselecting
project results immediately updates tool eligibility and the confirmation's deletion count. Busy project caches are
shown as unavailable. Tools starts unchecked unless explicitly selected with `--checkout tools`.

Use Tab on a project or Tools to open its subprojects or language groups. Up/Down moves and Space toggles a row. Enter
within a group returns to its parent; Enter at the top level shows confirmation below the selection. Parent checkboxes
show partial selection. Selecting a parent includes all its available children; individual children can be selected
without adding command options.

Selecting a project recursively includes every root, environment, and CI target; selecting Tools includes every eligible
shared installation. There is no recursive option. Escape, Ctrl-C, or declining confirmation removes nothing.
Noninteractive and `--json` invocations preview all candidates unless `--apply` is supplied; `--apply` bypasses the
selector. During deletion, terminals show a spinner, completed/total item counts, the current item, and elapsed time.
Redirected output prints start and completion summaries; `--json` remains structured output only. Ctrl-C stops further
removals after the current operation settles and releases its locks. An explicit checkout path excludes Tools; `tools`
is the virtual selector (use an absolute path or `./tools` for a real checkout with that name).

Project caches include build products, saved successful check results, and retained check logs. Installed project
dependencies require `--dependencies`. Inside a project, `--all` uses its storage preference; outside one, the user
preference applies. Project-local build directories remain the responsibility of `make clean` and `make distclean`.

Shared-tool pruning inspects Workbench's marked native installations, Rustup toolchains, and uv-managed Python. Active
Workbench commands and retained cached results protect their tools. Project pins and manager defaults do not create
permanent protection. Removing a cached result releases its tool references automatically; selecting both that result
and Tools removes them in one cleanup. Keeping a result preserves the tools it references, even if its original checkout
is gone or has changed configuration. Empty workspace preparation and logs alone do not pin SDKs.

The user-state `cache-tool-references.json` index records exact tool requirements with owned cached results. Pruning
refreshes it automatically from the results that still exist. There are no retain/forget commands or project lifecycle
registrations. Inspection does not write the index. Invalid ownership or unreadable reference metadata preserves tools
and reports the cause.

Pruning rechecks ownership, active commands, and retained-result references under locks before deletion. Workbench
shells and installers hold active leases for their selected tools; proven-dead local leases are reclaimed during
pruning. Rustup and uv remove their own installations. Nix/Guix stores, system packages, custom linked Rust toolchains,
unowned paths, and shared package downloads remain under their owning tools' control. Direct tool commands and external
shells do not hold Workbench leases; finish those before pruning. Versions are never deleted automatically when a
replacement is installed.

Directory names retain checkout/root hashes; the table groups full checkout paths, relative roots, and local CI targets.
Projects with the same base name remain distinct, and ownership receipts permit inspection after a checkout is removed.
`--checkout` cannot be combined with `--all`. Approximate sizes use decimal kB, MB, and GB; disappearing files are
silently skipped. Numbers align right and units align left, separated by one space. Multirow projects have a subtotal,
with a rule above it starting after the checkout column; a full rule separates projects. Unowned directories, redirected
paths, and mismatched receipts prevent deletion. After pruning dependencies or tools, run configured setup before direct
commands.

The supplied Dev Container descriptors forward the host checkout path even when opened directly in an editor. Older or
custom container runs without this setting may appear under their guest mount path, such as `/workbench`. Workbench does
not guess which host checkout owns those older caches; select their reported path explicitly when pruning them.

## Safe distribution output

Workbench distribution packaging builds in a private sibling directory and validates that tree before renaming it into
place. Outputs inside the source checkout must be beneath `dist/`; custom external output locations are also supported.
Only a previous output carrying the packager's ownership receipt can be replaced. An older unmarked directory must be
reviewed and moved or removed explicitly. Failed preparation preserves the prior output. This receipt identifies a
regenerable output; it is not a publisher signature.
