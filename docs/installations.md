# Install the Workbench command

Workbench's executable and adopted record collections have independent pins. Node.js 18.20.8 or newer can start the
launcher; the full CLI requires Node.js 22.23.3 or newer. One JavaScript package serves supported operating systems and
CPU architectures; installed Node and the selected tools supply host-specific binaries. npm and Git provide access to
independently pinned Workbench revisions. JavaScript runtime libraries are bundled; pnpm, TypeScript, and build
dependencies are not consumer prerequisites.

An installed Node satisfying the CLI requirement runs directly without acquisition or a Workbench artifact receipt. On
an older native Node satisfying the launcher minimum, Workbench hands off to its verified pinned runtime before loading
the CLI or acquiring a project-pinned executable. It reuses a cached SDK or acquires one through the authenticated
installer; first acquisition requires connectivity and GnuPG to verify the selected Node release's signed checksum
catalog. POSIX extraction also requires `tar` and XZ utilities. This does not change the system Node installation or
shell defaults. The bootstrap bundle uses Brotli so older Node can load it independently of the application's selected
compression.

Nix, Guix, prepared, and explicit Node compatibility environments retain their selected interpreter, which must satisfy
the full CLI minimum. A runtime below the launcher minimum fails before command loading or acquisition.

Project shells and check commands continue to select their own configured toolchains independently of the CLI's runtime.
Development pins govern those environments; a capable installed interpreter can run ordinary Workbench commands
directly.

Source and tests live in `app/src/` and `app/test/`; reference applications live in `examples/`. Workbench resolves
reference material from its distribution and immutable source identity, independently of the consuming project.
`workbench language` reports reference example locations, and `workbench language init` copies selected starters. Source
and test files are readable without development dependencies; running Workbench's own test suite requires its
development toolchain.

Container operations acquire the Dev Container CLI from its separate committed bootstrap manifest and npm lock under
`scripts/container-tools/`. They do not install Workbench's development dependencies.

## First installation

A manual Git clone is optional. Install Node.js and npm first, using the
[Node.js downloads](https://nodejs.org/en/download) for Windows or macOS, or your selected Linux package manager or Node
distribution. Use a version satisfying the full CLI requirement above to run directly. Verify `node --version` and
`npm --version` (`npm.cmd --version` in Windows PowerShell). Workbench does not require pnpm, a TypeScript compiler, or
its development dependencies.

Choose a release archive below, or install a user launcher from an exact Git commit. The Git route additionally requires
Git on `PATH` and the development Node pinned by that revision. npm acquires the source and prepares its locked
dependencies and bundles before installation. Prebuilt archives need no development setup. Release availability and
immutable revision selection come from your chosen Workbench provider.

On Linux or macOS:

```sh
npx --yes git+https://HOST/TEAM/workbench.git#FULL_COMMIT install --user
export PATH="$HOME/.local/bin:$PATH"
workbench --help
```

On Windows PowerShell:

```powershell
npx.cmd --yes "git+https://HOST/TEAM/workbench.git#FULL_COMMIT" install --user
$env:Path = "$env:LOCALAPPDATA\workbench\bin;$env:Path"
workbench.cmd --help
```

Replace the repository and full commit with the provider's reviewed immutable revision. These `PATH` changes apply to
the current shell; configure the same directory in your shell startup or Windows user `Path` for future terminals. The
`.cmd` spelling uses the Windows command shim without requiring PowerShell script execution-policy changes.

System and user installation describe executable locations. Project configuration independently selects which Workbench
revision that executable runs; it does not require a separate executable copy in each project.

## Install a release package

Install a supported Node.js runtime and npm, then verify `workbench.tar.gz` against the supplied `SHA256SUMS` using your
platform's SHA-256 tool, from the directory containing both downloads:

```sh
# Linux
sha256sum --check SHA256SUMS
# macOS
shasum -a 256 --check SHA256SUMS
```

In Windows PowerShell:

```powershell
$expected = ((Get-Content .\SHA256SUMS -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash .\workbench.tar.gz -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "Workbench archive checksum mismatch" }
```

The checksum checks agreement with the selected release's manifest; obtain both through the trusted provider's release
page. Install the verified local archive:

```sh
npm install --global --ignore-scripts ./workbench.tar.gz
workbench --help
```

In Windows PowerShell use `npm.cmd install --global --ignore-scripts .\workbench.tar.gz`, then `workbench.cmd --help`.
Ensure npm's executable directory is on `PATH`: the configured prefix on Windows, or its `bin` subdirectory on Linux and
macOS. `npm config get prefix` reports that prefix. npm's `--global` means installation outside the current project;
whether its prefix belongs to the user or the system depends on the Node/npm installation. See
[npm's directory conventions](https://docs.npmjs.com/cli/v11/configuring-npm/folders/).

npm creates the command in its configured installation prefix. A matching project pin runs directly from this package;
acquiring a different revision also requires Git and either connectivity or an existing npm cache entry. The package
contains prebuilt JavaScript and needs no TypeScript compiler or dependency installation at first launch.

The archive also retains the original source `package.json` as `workbench-source-manifest.json` for installation
verification. Its bytes are covered by the archive checksum; the active package manifest omits development dependencies
and lifecycle scripts. The retained source manifest is evidence, not an installation instruction.

For direct use, extract the archive and run `node workbench/bin/workbench.mjs`. On Linux and macOS, adding the extracted
`workbench/bin` directory to `PATH` also exposes the `workbench` command. Keep the extracted distribution together so
its runtime and reference assets remain available.

To create an archive-managed installation, run the extracted launcher with the archive and its expected checksum.

```sh
node workbench/bin/workbench.mjs install --archive ./workbench.tar.gz --sha256 SHA256
```

Use the SHA-256 value from the trusted release manifest. The installer verifies the archive and starts its CLI before
publishing the launcher. The launcher and a native service registered through it select the same installed release. This
installation keeps the application release independent of project collection pins. To set up a shared installation, run
the installer as an administrator and set `--directory` to a protected executable directory accessible to users.

## Update or roll back an archive-managed release

Run the installed command with the new archive and the checksum from its release manifest.

```sh
workbench update --archive ./workbench.tar.gz --sha256 SHA256
workbench update --rollback
```

For a shared installation, use its installed launcher with administrator access. An active systemd, launchd, or
Windows service drains its work and restarts using the selected version. Workbench waits for the replacement to listen
and restores the previous version if startup fails. A shared LaunchDaemon keeps its socket registration loaded during
the switch. Stop manual servers before updating. The installed launcher stays in the same location and project
collections update separately.

If the update process stopped during the switch, run `workbench update --recover` using the same installed command
and account. The launcher uses the previous verified release for recovery. Workbench restores that selection and
restarts the service if it was running before the update.

Repair a missing or damaged launcher from a separately extracted copy of the verified archive.

```sh
node workbench/bin/workbench.mjs install --repair --directory /path/to/bin \
  --archive ./workbench.tar.gz --sha256 SHA256
```

Use the active archive, or the previous archive during an interrupted update. The installer restores a missing
launcher or replaces a damaged launcher that still has its Workbench header. It saves a copy of the damaged file in
the installation's `repair` directory and preserves unrelated executables. Repair keeps the release selection intact.
After repairing the launcher for an interrupted update, use `workbench update --recover`.

## Use the project pin without installing a launcher

With the pinned source revision's Node.js, npm, and Git prerequisites, use the `repository` and `revision` in the
project's `[tool]` configuration:

```sh
spec='git+https://HOST/TEAM/workbench.git#FULL_COMMIT'
npm exec --yes --package="$spec" -- workbench project add .
npm exec --yes --package="$spec" -- workbench tools install
npm exec --yes --package="$spec" -- workbench check
```

Use the configured repository URL, including SSH if selected, and its full commit ID. npm uses its package cache for
subsequent invocations. A persistent launcher on `PATH` remains convenient for Git hooks and Make targets.

## Install a user launcher

Acquire the executable from an exact Git commit and install a launcher:

```sh
npx --yes git+https://HOST/TEAM/workbench.git#FULL_COMMIT install --user
```

Replace `HOST`, `TEAM`, and `FULL_COMMIT`. Recorded package identity or npm's installation metadata supplies the
selected commit; an existing project's `[tool]` pin can also supply the default. For a plain source checkout without
either, pass `--repository https://HOST/TEAM/workbench.git` and `--revision FULL_COMMIT` explicitly. `workbench init`
records the executing package pin when available.

Repository sources use HTTPS or SSH URLs on any Git host, with an optional npm `git+` prefix. For SSH, use a full URL
such as `ssh://git@HOST:2222/TEAM/workbench.git`. npm and Git perform acquisition and use their normal credential
lookup; keep passwords and tokens out of repository URLs. Repository URLs contain no query or revision fragment; the
immutable commit belongs in `revision`. Workbench normalizes the URL to npm's explicit Git form before acquisition.

The launcher prefers npm supplied with its selected Node runtime over an unrelated npm on `PATH`, while honoring an
explicit `npm_execpath`. npm configuration and Git credentials remain available during acquisition.

Default HTTPS and Git SSH URLs on GitHub.com and GitLab.com identify the same repository when checking the executing
revision and reusing npm's cache. Acquisition keeps the configured transport and credentials. Custom SSH users, ports,
and host aliases remain distinct. A repeated launcher handoff fails with the requested and executing identities instead
of repeatedly launching npm.

The default location is `~/.local/bin/workbench` on Linux and macOS, or `%LOCALAPPDATA%/workbench/bin/workbench.cmd` on
Windows. User installation runs from an ordinary shell without administrator access. `--directory PATH` selects another
location, including a system directory when running with appropriate access. Installation preserves unrelated
executables and reports when its directory is absent from `PATH`. It does not edit shell startup files or replace system
or user Node.js/npm installations.

Installation also writes completion for the detected shell: Bash, Zsh, Fish, or PowerShell. It preserves unrelated
completion files and reports any startup configuration needed. On Linux, Bash's standard `bash-completion` package and
Fish load their user completion files automatically. Other installation locations may need explicit sourcing. Zsh
requires its completion directory in `fpath` before `compinit`; PowerShell requires sourcing the completion file from
its profile. Existing source-checkout users can install completion separately with `workbench completion install bash`
(or `zsh`, `fish`, `powershell`). Installed completions query the active executable, so command additions and renames do
not require reinstalling completion.

## Administrator installation

For a shared command, install the verified release archive into a system-owned npm prefix. Use an npm executable
available to the administrator account. On Linux or macOS, a conventional prefix is `/usr/local`:

```sh
sudo npm install --global --ignore-scripts --prefix /usr/local /absolute/path/workbench.tar.gz
```

This places the command in `/usr/local/bin`. On Windows, open PowerShell as Administrator and select a shared prefix:

```powershell
npm.cmd install --global --ignore-scripts --prefix "$env:ProgramFiles\workbench" C:\Downloads\workbench.tar.gz
```

The Windows command is placed directly in that prefix. Replace the archive paths with the verified local download.
Arrange a supported Node.js runtime and the appropriate command directory on `PATH` for the intended users. Windows
machine `Path` changes require an administrator; user `Path` changes apply only to that account. The installer does not
change `PATH` automatically.

Use an ordinary account for subsequent project initialization, acquisition, configuration, and checks. Install shell
completion from that account with `workbench completion install SHELL`. For a single account with a user-managed Node
installation, the user installation above avoids maintaining a separate administrator environment.

## Register the Linux service

On a systemd host, register the service from the installed release. A user service runs under the account's own systemd
manager and uses the same private sign-in as a foreground server.

    workbench install --service user
    systemctl --user enable --now workbench.service

A shared system service uses the system-owned release and a protected loopback port. Run registration and startup with
administrator privileges.

    sudo /usr/local/bin/workbench install --service system
    sudo systemctl enable --now workbench.service

The starting ports are 8080 for a user service and 80 for a system service. Use `--port PORT` at registration to choose
a different port. A system port must be protected against ordinary user binds. Running `workbench serve` from an
ordinary account prints the active service's URL, your OS username, and the generated password to enter in the browser.

Use `systemctl status workbench.service` and `journalctl -u workbench.service` to inspect the system service. For the
user service, add `--user` to both commands.

Remove the registration from the manager that owns it.

    workbench uninstall --service user
    sudo /usr/local/bin/workbench uninstall --service system

Each command drains and removes the selected Workbench-owned service. The other manager's registration, the installed
release, and its data remain available. Use systemd drop-ins for local overrides. Workbench preserves an edited base
definition.

Native qualification uses the candidate's `workbench-artifacts` directory and temporary OS accounts. The system check
uses two accounts to verify isolation and shared admission. Run it on a disposable Linux runner with systemd,
administrative access, and Bubblewrap with working user and network namespaces.

    bash scripts/check-linux-service.sh user /path/to/workbench-artifacts
    bash scripts/check-linux-service.sh system /path/to/workbench-artifacts

## Register the macOS user service

From a graphical login session, use the installed, verified command to register a LaunchAgent for your account.

    workbench install --service user
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.workbench.app.plist"

The LaunchAgent runs at graphical login. Run `workbench serve` to obtain the active listener's URL and sign-in. Each
restart invalidates the previous password. Inspect its status with `launchctl print "gui/$(id -u)/org.workbench.app"`.
Remove the registration with `workbench uninstall --service user`. Removal drains the listener and preserves application
files and user data.

To register a shared LaunchDaemon, use the archive-managed system installation with an administrator-owned Node.js
runtime. Select the installed Xcode or Command Line Tools with `xcode-select` so account workers can run Git without an
interactive setup prompt. The release archive includes the macOS launcher.

    sudo /usr/local/bin/workbench install --service system
    sudo launchctl bootstrap system /Library/LaunchDaemons/org.workbench.app.plist

Launchd owns the fixed loopback port while the registration is loaded. Choose it with `--port PORT` during registration.
Run `workbench serve` from each account for its URL, username, and password. The daemon's next process requires a new
sign-in. Use `sudo launchctl print system/org.workbench.app` to inspect the registration. Use
`sudo /usr/local/bin/workbench uninstall --service system` to remove it and preserve the installation and account data.

## Register the Windows service

Install a verified archive containing the native Windows service helper. A user registration uses Windows Task
Scheduler and starts under your account when you sign in. Use the installed command from that account.

```powershell
workbench install --service user
```

Run the start command printed by Workbench to start the registered task during the current Windows session. Run
`workbench serve` to get the listener URL and sign-in credentials. Use the same command with `--daemon` to start a
private background server without registering a logon task. A private server requires fresh browser sign-in after a
restart. An update of an active logon task drains the registered server and starts the selected release in the signed-in
Windows session.

For a shared installation, run registration and startup from an administrator PowerShell using the installed release
in a protected directory and a port Windows permits Workbench to reserve.

```powershell
workbench install --service system
Start-Service WorkbenchApplication
```

The shared service starts with Windows. An ordinary account runs `workbench serve` to sign in and open its own projects.
After a service restart, run it again for a fresh password.
View registered user task status in Task Scheduler and shared service status with `Get-Service WorkbenchApplication`.
When private listeners are active, the shared service waits before opening its browser port. Stop the private listeners
to finish startup. `Stop-Service WorkbenchApplication` cancels the wait and leaves the private listeners running.

Stop the user task in Task Scheduler before removing it with `workbench uninstall --service user`. Use an administrator
PowerShell to remove the shared service with `workbench uninstall --service system`. The installed release and its
data remain available.

### Extended service checks

Build the candidate release first. Set `WORKBENCH_EXTENDED_ARTIFACTS` to its absolute `workbench-artifacts`
directory, or place it in the default `dist/workbench-artifacts` directory. The runner verifies the archive
against its `SHA256SUMS` file. To test native service installation, restart, and removal on a disposable Linux,
macOS, or Windows host, run the following with the permissions the installed service needs.

```sh
WORKBENCH_EXTENDED_DISPOSABLE_HOST=1 workbench check --extended --role installed-services
```

Test automatic Windows startup from a Linux x64 host with access to KVM, QEMU, and `virt-customize` with its Windows
first-boot helper. Prepare a powered-down Windows Server 2025 Desktop Experience guest in a standalone qcow2 image
that boots with Q35. Retain a SHA-256 for that image and for the pinned, verified Windows x64
`node.exe`. Point `WORKBENCH_WINDOWS_STARTUP_INPUTS` to an absolute JSON file with both inputs.

Use a base that `virt-inspector --format=qcow2 -a IMAGE` recognizes as Windows. If the host's NTFS reader cannot read
Compact OS files, run `compact.exe /CompactOS:never` inside the disposable Windows guest as administrator. Shut it down
before recording the new image checksum. [Microsoft Compact OS documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact)

```json
{
  "image": { "path": "/path/to/windows-server.qcow2", "sha256": "IMAGE_SHA256" },
  "node": { "path": "/path/to/node.exe", "sha256": "NODE_SHA256" }
}
```

For a UEFI image, add a `firmware` object with `code` and `variables` inputs in the same path-and-digest form. Use a
matching x64 OVMF pair. The runner gives the guest a private writable copy of the variables file. Omit `firmware` for
a BIOS image. If the VM tools are outside Workbench's native PATH, set `tools` to the absolute directory containing
`qemu-img`, `qemu-system-x86_64`, and `virt-customize`.

```sh
WORKBENCH_WINDOWS_STARTUP_INPUTS=/path/to/windows-inputs.json workbench check --extended --role windows-startup
```

Keep the verified base image unchanged while the check is running. The runner injects the candidate and verifier
into a fresh copy-on-write overlay, then boots without networking. The verifier checks SCM startup before desktop
sign-in and Task Scheduler startup in a fresh ordinary user's desktop. Workbench reports both results and discards
the writable overlay after shutdown or cancellation. If the runner is forcibly terminated, its next run can reclaim
the overlay once its owner and guest processes have exited. The ordinary Windows CI job continues to exercise
installation, restart, update, rollback, and removal.

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

The launcher reuses an npm-cached executable only when npm's installation metadata binds it to the exact requested
repository and commit. This avoids another Git acquisition for cached revisions, including repositories on other Git
hosts. Missing, incomplete, conflicting, or unrecognized cache entries go through npm acquisition instead.

A release package records its source and immutable revision, so a matching project pin runs without npm acquisition.
Offline use also requires either a capable installed Node or the cached verified SDK needed by an older bootstrap Node.
Dispatch to another revision requires connectivity unless npm has that package cached. To select cached packages
offline, use npm's offline setting, for example `npm_config_offline=true workbench validate`; cache eviction can require
reacquisition. Committed records and agent context remain readable without either the executable or its cache.

Git source installation runs the `prepare` entry with the pinned development Node. The source checkout disables
automatic dependency lifecycle scripts; preparation activates the frozen pnpm graph before building. Release archives
omit development dependencies and lifecycle scripts. See [source setup](contributing.md#build-and-distribution).

## Inspect the selected executable

```sh
workbench executable
workbench executable --json
```

Inspection reports the Workbench copy actually running after project/default revision selection. JSON output has
`version: 1`, `repository`, `revision`, `directory`, and `node` fields. `node.executable` and `node.version` identify
the actual runtime. Repository and revision are `null` when a development copy has no recorded immutable source; they
are never inferred from a nearby checkout. Inspection requires no project initialization and acquires no additional
tools once the selected executable and runtime are available.

## Updates and completion

`workbench update FULL_COMMIT` prepares an executable-pin update in an isolated checkout and applies only a successfully
validated result. It requires a clean committed checkout and neither stages nor commits changes. Collection updates use
`workbench collection update` separately. Review the diff and run applicable checks before committing.

The installed release handles `update` even when the project selects an older executable. When the requested target
matches that installed release's recorded source identity, preparation and synchronization reuse it without another npm
acquisition. Other target revisions are acquired by their exact pin.

`workbench completion install bash` installs completion; zsh, fish, and PowerShell are also supported. Completion and
launcher installation are separate explicit operations. Workbench's own source checkout continues to use
`node bin/workbench.mjs` while developing.
