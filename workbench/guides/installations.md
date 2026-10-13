# Shared Workbench installations

[ADR-2](../decisions/ADR-02.md) defines dependency ownership; [ADR-J](../decisions/ADR-0J.md) defines access boundaries.
Installation profiles are separate from development and release profiles.

## Choose a dependency mode

| Mode | Tracked selection | Dependency location |
| --- | --- | --- |
| Project submodule | Exact Git gitlink | `.workbench` checkout in each project |
| Shared installation | `workbench/distribution.json`: exact Git revision and seal SHA-256 | Immutable user/system store, routed through an ignored `.workbench` link |

Keep source, tests, and examples once per installed version for reference. A distribution may omit those entire trees;
its seal still supplies their cache identities. Installing another version never updates existing projects. Commands,
ADRs, language definitions, skills, hooks, and adapters all follow the project pin. Missing versions fail explicitly.

## Prepare and install

From a reviewed Workbench source revision, `make release` prepares `dist/workbench`. Packaging writes
`workbench-distribution.json`, an inventory of regular-file SHA-256 values, executable permissions, and contained links.
The seal's SHA-256 identifies the complete inventory; select that digest through a trusted release channel. Inspecting
untrusted contents alone does not establish their provenance.

```sh
workbench installation inspect /path/to/distribution
workbench installation install /path/to/distribution --sha256 SHA256 --default
```

Installation checks the selected digest and inventory, copies only inventoried contents into private staging, verifies
the result, then publishes an immutable version. Installation never executes candidate code, configuration, or hooks.
Normal project commands execute the explicitly selected version with the caller's authority.

Default user stores are `$XDG_DATA_HOME/workbench/installations` on Linux (fallback `~/.local/share`), Workbench's user
application-data directory on macOS and Windows. System lookup uses Linux `$XDG_DATA_DIRS` (fallback
`/usr/local/share:/usr/share`), `/Library/Application Support/workbench/installations` on macOS, and
`%PROGRAMDATA%/workbench/installations` on Windows. `--directory PATH` selects an explicit store.

`--default` installs stable launchers under the store's `bin` directory. Add that directory to PATH. Change this default
with `workbench installation default SHA256`; project pins continue selecting their own versions. Node.js remains a
runtime prerequisite; running Workbench does not download its application dependencies.

## Register a checkout

From the consuming repository:

```sh
workbench installation register SHA256              # First selection
workbench setup --id PROJECT_ID
workbench installation register                     # Another clone, using its tracked pin
workbench installation register --repair            # Explicit repair after moving a checkout or changing branches
```

Supply `--directory PATH` when using a custom store. Registration adds local-state ignore rules, creates the portable
pin, protects its version, and creates the ignored dependency link. Each checkout has its own profile, including Git
worktrees. `workbench/.installation.json` contains private machine lookup and registration details; never commit it.
Windows uses a directory junction for the local routing link. Repairing a moved checkout creates a separate profile;
the previous root remains until explicitly removed, since a copied registration cannot prove the old checkout is unused.

Provide the project's human-written charter before validation. Generated context and skill links use project-relative
`.workbench` references. Ordinary commands refuse a link that differs from the selected pin. Registration does not
replace a real `.workbench` directory: preserve or explicitly migrate a previous submodule first.

CI machines install the same sealed version and register the checkout. A proposed-tree hook or local CI rehearsal
materializes that exact dependency into its disposable snapshot; it does not depend on a host-specific symbolic link.
Containers receive a verified read-only distribution mount. Rebuild an existing Dev Container when its selected mounts
change. Shared installations in Linux Dev Containers use a POSIX host; on Windows, install and run Workbench inside
WSL 2. Optional Dev Container CLI dependencies live in the user's cache, outside immutable installed contents.

## Update and retain generations

Install the candidate first, then use a clean, committed project checkout:

```sh
workbench update SHA256
workbench installation generations
workbench installation generations --forget OLD_SHA256
```

Updates accept an installed full seal SHA-256 or an unambiguous exact Git revision. They prepare record migrations,
formatting, context, and validation in an isolated checkout before changing the project. The result is an unstaged diff;
ADR review remains required. Submodules retain their existing fetch-and-update workflow.

Old selections remain rollback generations until explicitly forgotten. The current selection cannot be forgotten.
`workbench installation unregister` releases this checkout's profile and local link but preserves its tracked pin.
Returning to a historical branch whose version has been pruned requires explicitly reinstalling that version.

## Inspect and prune

```sh
workbench installation list
workbench installation prune                         # Preview retained and unreferenced versions
workbench installation prune --apply                 # Remove only unreferenced, verified versions
```

Profiles, rollback generations, default-launcher generations, active commands, and recovery operations protect their
versions. Metadata identifies owners and retention reasons without publishing private project paths. Pruning does not
crawl project directories or infer expiry from missing paths, timestamps, or process IDs.

Maintenance fences new registrations before scanning roots. A concurrent registration either remains visible or fails
before using the version. An unreadable root, abandoned writer claim, incomplete installation, or unknown metadata
stops pruning. Interrupted commands may leave conservative roots: inspect their purpose before removing an owned root
with `workbench installation roots remove ROOT_UUID`.

An interrupted collector may leave a maintenance claim and a busy fence. Inspect the store and confirm no maintenance
operation remains before manually removing its `maintenance.lock` directory; `workbench installation recover` validates
all roots before reopening registration. Never remove another account's roots to make pruning pass. Failed project
updates retain an explicit Git-directory recovery receipt when rollback is uncertain.

## System ownership

An administrator uses `installation install --scope system` and provisions accounts with
`installation provision UID_OR_SID`. Ordinary users register projects and mutate only their own private root directory;
they cannot write immutable contents or another account's namespace. System listing, pruning, default selection, and
repair require administrator authority and account for every provisioned owner, including logged-out users.

POSIX stores use ownership and directory modes. Windows uses protected DACLs with administrator/system maintenance
rights and separate account directories; ordinary file modes do not provide equivalent owner separation. See
[Node filesystem semantics](https://nodejs.org/api/fs.html) and
[Windows access-control permissions](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls).
Administrative installation and pruning never run project configuration or migrations. Run project registration,
updates, and checks as the project owner.
