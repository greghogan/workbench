# Install the Workbench command

Workbench's executable and adopted record collections have independent pins. Node.js 18.20.8 or newer can start the
launcher; the full CLI requires Node.js 22.23.3 or newer. One JavaScript package serves supported operating systems and
CPU architectures; installed Node and the selected tools supply host-specific binaries. npm and Git provide access to
independently pinned Workbench revisions. JavaScript runtime libraries are bundled; pnpm, TypeScript, and build
dependencies are not consumer prerequisites.

An installed Node satisfying the CLI requirement runs directly without acquisition or a Workbench artifact receipt. On
an older native Node satisfying the launcher minimum, Workbench hands off to its verified pinned runtime before loading
the CLI. It reuses a cached SDK or acquires one through the authenticated installer; first acquisition requires
connectivity. This does not change the system Node installation or shell defaults. The bootstrap bundle uses Brotli so
older Node can load it independently of the application's selected compression.

Nix, Guix, prepared, and explicit Node compatibility environments retain their selected interpreter, which must satisfy
the full CLI minimum. A runtime below the launcher minimum fails before command loading or acquisition.

Project shells and check commands continue to select their own configured toolchains independently of the CLI's runtime.
Development pins govern those environments; a capable installed interpreter can run ordinary Workbench commands
directly.

The installed package includes `src/`, `tests/`, and `examples/` as reference material. Workbench resolves these from
its executable distribution directory, independently of the consuming project. `workbench language` reports reference
example locations, and `workbench language init` copies selected starters. Source and test files are readable without
development dependencies; running Workbench's own test suite requires its development toolchain.

Container operations acquire the Dev Container CLI from its separate committed bootstrap manifest and npm lock under
`scripts/container-tools/`. They do not install Workbench's development dependencies.

## Install a release package

Install a supported Node.js runtime and npm, then verify `workbench.tar.gz` against the supplied `SHA256SUMS` using your
platform's SHA-256 tool. Install the verified local archive:

```sh
npm install --global --ignore-scripts ./workbench.tar.gz
workbench --help
```

npm creates the command in its configured installation prefix. A matching project pin runs directly from this package;
acquiring a different revision also requires Git and either connectivity or an existing npm cache entry. The package
contains prebuilt JavaScript and needs no TypeScript compiler or dependency installation at first launch.

For direct use, extract the archive and run `node workbench/bin/workbench.mjs`. On Linux and macOS, adding the extracted
`workbench/bin` directory to `PATH` also exposes the `workbench` command. Keep the extracted distribution together so
its runtime and reference assets remain available.

## Install a user launcher

Acquire the executable from an exact Git commit and install a launcher:

```sh
npx --yes git+https://HOST/TEAM/workbench.git#FULL_COMMIT install --user
```

Replace `HOST`, `TEAM`, and `FULL_COMMIT`. Recorded package identity or npm's installation metadata supplies the
selected commit; an existing project's `[tool]` pin can also supply the default. For a plain source checkout without
either, pass `--repository https://HOST/TEAM/workbench.git` and `--revision FULL_COMMIT` explicitly. `workbench setup`
records the executing package pin when available.

Repository sources use HTTPS or SSH URLs on any Git host, with an optional npm `git+` prefix. For SSH, use a full URL
such as `ssh://git@HOST:2222/TEAM/workbench.git`. npm and Git perform acquisition and use their normal credential
lookup; keep passwords and tokens out of repository URLs. Repository URLs contain no query or revision fragment; the
immutable commit belongs in `revision`. Workbench normalizes the URL to npm's explicit Git form before acquisition.

The default location is `~/.local/bin/workbench` on Linux and macOS, or `%LOCALAPPDATA%/workbench/bin/workbench.cmd` on
Windows. `--directory PATH` selects another location, including a system directory when running with appropriate access.
Installation preserves unrelated executables and reports when its directory is absent from `PATH`. It does not edit
shell startup files or replace system or user Node.js/npm installations.

Installation also writes completion for the detected shell: Bash, Zsh, Fish, or PowerShell. It preserves unrelated
completion files and reports any startup configuration needed. On Linux, Bash's standard `bash-completion` package and
Fish load their user completion files automatically. Other installation locations may need explicit sourcing. Zsh
requires its completion directory in `fpath` before `compinit`; PowerShell requires sourcing the completion file from
its profile. Existing source-checkout users can install completion separately with `workbench completion install bash`
(or `zsh`, `fish`, `powershell`). Installed completions query the active executable, so command additions and renames do
not require reinstalling completion.

## Select a project revision

```toml
[tool]
repository = "https://HOST/TEAM/workbench.git"
revision = "FULL_IMMUTABLE_GIT_COMMIT"
```

Use an actual full Git commit, not a branch or moving tag. From the project or a nested directory, run:

```sh
workbench validate
workbench record add task "First project task"
```

The launcher finds project configuration, selects the exact package, preserves the working directory and arguments, and
invokes npm. Outside a configured project it uses the default chosen during installation. npm owns package caching;
Workbench maintains no installation profiles, retention roots, or project executable submodules.

A release package records its source and immutable revision, so a matching project pin runs without npm acquisition.
Offline use also requires either a capable installed Node or the cached verified SDK needed by an older bootstrap Node.
Dispatch to another revision requires connectivity unless npm has that package cached. To select cached packages
offline, use npm's offline setting, for example `npm_config_offline=true workbench validate`; cache eviction can require
reacquisition. Committed records and agent context remain readable without either the executable or its cache.

Workbench's source build script is named `bundle:build`. npm treats a Git dependency with a `build` script as requiring
preparation, so the source manifest deliberately avoids that and other installation lifecycle scripts. See
[npm's Git dependency rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#git-urls-as-dependencies).

## Updates and completion

`workbench update FULL_COMMIT` prepares an executable-pin update in an isolated checkout and applies only a successfully
validated result. It requires a clean committed checkout and neither stages nor commits changes. Collection updates use
`workbench collection update` separately. Review the diff and run applicable checks before committing.

`workbench completion install bash` installs completion; zsh, fish, and PowerShell are also supported. Completion and
launcher installation are separate explicit operations. Workbench's own source checkout continues to use
`node bin/workbench.mjs` while developing.
