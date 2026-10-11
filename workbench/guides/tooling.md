# Native tools, caches, and cleanup

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

Install the declared native tools without Guix, Nix, or a universal version manager:

```sh
./bin/workbench tools                        # Pins and installation locations
./bin/workbench tools install                # All registered roots
./bin/workbench tools install --path examples/languages/rust
make build
```

Bootstrap with a Node version satisfying `package.json`'s `engines.node`, Git, Bash, and the system archive tools (`tar`
and `xz` on POSIX; Windows includes `tar.exe` and needs Git Bash). Workbench downloads verified upstream artifacts for
Node, Go, LLVM, and standalone tools; Rust uses rustup and Python uses pinned uv. Selected GCC versions build from
verified GNU source archives on Linux, with prerequisites verified by GCC's pinned download script. GCC source
installation additionally needs a working C/C++ bootstrap compiler, Make, and curl or wget. It installs rustup when
absent and each Rust root's declared components, including rust-analyzer. Rust roots may also declare
`rust-toolchain-miri.toml` for a separately pinned Miri nightly; see the Rust reference for its explicit check role.
GitHub API downloads use `GH_TOKEN` or `GITHUB_TOKEN` when supplied, solely for `api.github.com`; redirects to asset
hosts do not receive those credentials. Signature and attestation verification still applies.

Installations do not replace system packages or change the parent shell's `PATH`. Checks and `workbench shell` select
the installed pins; ordinary checks never install or repair compiler versions. Package setup still uses the configured
dependency locks.

Package-manager bootstrap uses each ecosystem's verified installer. Maven's reference pins dependencies and plugins in
the POM and commits an artifact checksum allowlist; Maven verifies resolved bytes, including cached artifacts, against
it. RubyGems installs the lockfile's Bundler version from a verified local gem. Composer's pinned PHAR is verified with
its recorded digest and upstream signature; the project-owned Composer plugin checks dependency distribution archives
against reviewed SHA-256 values before extraction. Ordinary checks never learn new hashes. Explicit dependency updates
regenerate the corresponding lock/checksum data for review. See the [Java](../../examples/languages/java/README.md),
[Ruby](../../examples/languages/ruby/README.md), and [PHP](../../examples/languages/php/README.md) references for the
commands.

Native Ruby source builds use authenticated release sources and private staging; Windows uses signed RubyInstaller
archives. PHP uses signed sources for Unix CLI builds and official Windows x64 ZIPs. The currently pinned Ruby gems, PHP
Windows ZIPs, and Xdebug sources have explicit proof-absence metadata where publishers provide no applicable signatures
or attestations. The recorded digests remain mandatory. Native extension caches are specific to their runtime and ABI;
source builds require the host development SDK.

Bundled artifact metadata covers Linux x64/arm64, Windows x64, and macOS arm64 for the declared native tooling. Windows
ARM64 is unsupported. Compilers, runtimes, and installed helpers use native architecture artifacts. GCC installation and
compatibility coverage support Linux x64 and arm64 only; Clang supports every declared native platform. This policy is
documented in ADR-14 and inherited by ADR-15 for C++. Unlisted pins require reviewed additions to
`scripts/native-assets.json` (LLVM uses `scripts/llvm-assets.json`) or matching tools supplied on `PATH`. Pins remain
authoritative in each root; artifact metadata records acquisition URLs, SHA-256 digests, upstream proofs, and explicit
proof absence. [Pinned trust material](../../scripts/keys/README.md) records the verification authorities. OpenPGP
verification requires GnuPG; Linux runtime package extraction also requires binutils and XZ utilities.

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
authenticated archive without retaining it. LLVM 23's pinned Zstandard artifacts require an explicit 1 GiB
decompression-window cap; the default for other filtered artifacts remains 128 MiB. Failed installations remove their
private staging directories, and successful installations activate by atomic rename. Ordinary tar downloads pass a
bounded streaming preflight before platform extraction; ZIP files use lazy directory iteration and bounded file streams.
The default limits are 4 GiB incoming, 24 GiB decompressed, 4 GiB retained, 1 GiB per file, 64 KiB per metadata entry,
100,000 entries, and a 30-minute acquisition or extraction deadline. The pinned GCC 14 source explicitly allows 200,000
headers; GCC 15 and 16 allow 400,000, including PAX metadata. GCC 16.2.0 has 165,079 members and 330,158 raw headers.
Source checksums remain mandatory independently of these limits. `workbench tools --json` exposes expected installation
paths and acquisition policy identities without downloading or rehashing tools. Filtered manifests bind retained content
to the source, filter, resource limits, proof identities, and trust digests. Changing those inputs selects a distinct
filtered installation and CI cache. Local integrity hashes do not replace publisher authentication.

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

Cached GCC installations use the current Linux host's SDK. On Debian and Ubuntu, native selection adds existing
architecture-specific SDK include and library directories so the compiler can find libc headers and startup objects.

The C/C++ references use vcpkg manifest mode. `.vcpkg-version` pins the tool checkout; `vcpkg-configuration.json` pins
the Git registry baseline independently of the tooling version. `vcpkg.json` declares dependencies. The C CLI uses
yyjson and C++ uses fmt. vcpkg additionally needs curl, zip, pkg-config, and the usual POSIX text utilities. Builds
acquire the pinned tool in the Workbench toolchain cache and use the selected compiler through a generated CMake
triplet. Sources use the Workbench download cache (or `VCPKG_DOWNLOADS`); build trees and installed libraries use the
root's selected build cache. vcpkg's standard binary cache is shared, keyed by compiler, triplet, recipes, and declared
ABI-relevant environment. `VCPKG_BINARY_SOURCES` can configure a remote cache. Baselines set version floors; use
explicit overrides when a dependency needs an exact exception. The C/C++ dependency-refresh skills cover both
declarations.

## Build and dependency storage

### Platform locations

Workbench follows [ADR-I](../decisions/ADR-0I.md). Linux uses the
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

### Cleanup and external storage

`make clean` removes build outputs and test/tool caches from Workbench and all language references. `make distclean`
also removes dependency installations. Each reference supports the same targets from its own directory. Cleanup removes
this checkout/root's marked build directories across environments and toolchain revisions. Both preserve the checked-in
bundle, source files, lockfiles, dependency download caches, installed toolchains, unrelated Cargo targets, and Nix/Guix
stores. Concurrent Workbench check sessions and cleanup of the same root are rejected.

Cleanup executes configured commands on the working checkout, without toolchain probes, dependency setup, or managed
containers. `make release ROOT=.` prepares `dist/workbench`, a runnable copy excluding local settings, dependencies, and
generated caches. All ten language references publish local release artifacts into `dist/`; ordinary builds and
intermediate files follow the selected storage mode. Rust selects executable artifacts from Cargo's build report.

Build outputs and dependency installations stay in gitignored project directories by default: Cargo `target/`,
TypeScript `build/`, C/C++ and Go `build/`, Node `node_modules`, and Python `.venv`. Package-manager download caches
retain their native locations in local storage mode. Release artifacts remain in `dist/` and CI reports in `coverage/`
in either mode. Coverage intermediates use the selected build storage. Workbench removes its raw V8 dumps and merge
inputs after processing, including on failure; `coverage/` retains the test results and final reports.

For network checkouts or a separate build disk, opt in once in **global user configuration**:

```sh
workbench config
workbench config set storage.external true
workbench config get storage.external
# Optional: choose a different external storage root.
workbench config set storage.root /mnt/fast/workbench
workbench config unset storage.root
```

`workbench config` shows global defaults/preferences, human-managed project options, and ignored local overrides in a
`SCOPE | SECTION | KEY | VALUE` table, with their file paths. Agent-managed `automation.toml` is separate. `<unset>`
means that scope makes no declaration. `get` prints the configured value, including an applicable local override;
`--scope global`, `--scope project`, or `--scope local` inspects that file alone. Outside a project, inspection shows
global options without initializing a project.

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

`workbench paths --path examples/languages/rust` prints the selected locations without creating them. Checks and
`workbench shell` prepare and export the same native controls. For direnv, add
`eval "$(workbench paths --path examples/languages/rust --shell)"` to `.envrc.local`, after any older Cargo target
override. This exports paths only; it does not select or install tools. Use the matching Workbench shell for managed
environments. An active shell retains its storage selection; reopen it after changing global settings. Plain commands
outside a configured shell retain their native defaults.

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
`workbench checks run --role setup --path ROOT` restores the configured layout from the existing lockfile and removes a
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

## Safe distribution output

Workbench distribution packaging builds in a private sibling directory and validates that tree before renaming it into
place. Outputs inside the source checkout must be beneath `dist/`; custom external output locations are also supported.
Only a previous output carrying the packager's ownership receipt can be replaced. An older unmarked directory must be
reviewed and moved or removed explicitly. Failed preparation preserves the prior output. This receipt identifies a
regenerable output; it is not a publisher signature.
