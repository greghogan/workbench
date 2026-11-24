---
status: Accepted
added_at: 2026-11-19T13:03:31.091Z
---

# TSK-4: Share Nix and Guix preparation stores and prune superseded assets

## Review summary

Keep prepared development profiles available across Docker cleanup and share their packages across projects. Enable Nix
and Guix independently by selecting either the system daemon or a Workbench-managed Docker store.

| Manager | System preparation                                                                                   | Managed preparation                                        |
| ------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Nix     | Use the host Nix daemon and register the realized profiles as roots.                                 | Mount store data at `/nix`.                                |
| Guix    | Use the host Guix daemon and register the realized profiles, runtimes, and pinned managers as roots. | Mount the store at `/gnu` and daemon state at `/var/guix`. |

Each managed store has its own directory under the configured Workbench cache and one compatible daemon. Routine cache
cleanup preserves live profiles. The Docker engine must be able to bind the cache directory from its host.

Pin the realized environment for each project, profile, and requested architecture. When a project releases one of its
pins, the package manager can reclaim unreachable data while preserving other projects' profiles. Keep the previous
working profile and any active or explicitly retained outputs until their requirements are released. Remove staging
archives after successful import and verification when retained profiles can regenerate them.

Use the existing cache inventory and prune commands to show shared data, eligible assets, active use, and pending
recovery. Track older local images and BuildKit intermediates separately from profile pins. Clear intermediates
independently of prepared images. Published registry images retain their explicit cleanup workflow.

### Store selection

Choose a backend for each manager in the user's Workbench configuration. Both settings default to `"disabled"`.

```toml
[preparation]
nix_store = "disabled"
guix_store = "disabled"
```

- `disabled` leaves that manager's image preparation and store maintenance inactive.
- `system` uses the system daemon.
- `managed` uses a persistent Docker-backed store under the Workbench cache. `WORKBENCH_CACHE_HOME` controls its
  location through the existing cache-root override.

Check the selected store before building a Nix or Guix development image locally. This covers
`workbench development prepare PROFILE --build` and the local build path reached through interactive
`workbench development images` or a local `workbench ci` rehearsal. Pulling or verifying an existing prepared image does
not need a preparation store.

If the manager is disabled, fail with the configuration key and the two ways to enable it. If the selected daemon is
unavailable, fail with its name and the startup command where known. For Guix on systemd, if the unit is installed, show
`sudo systemctl start guix-daemon.service`. Also show how to choose the managed store, such as
`workbench config set --scope global preparation.guix_store managed`. Report the backend and location on local builds.

### Delivery checklist

- [x] Add Nix store reuse, durable profile pins, inventory, and pruning for system and managed stores.
- [x] Add Guix store reuse, durable profile pins, inventory, and pruning for system and managed stores.

## Implementation account

Local image builds use an explicit preparation store selected in personal configuration. System mode probes the daemon
before assembly. Managed mode selects Docker even when the manager is installed. Prepared image reuse and verification
bypass store selection. The image publication workflow explicitly selects its managed store on CI runners.

Lock inspection and recovery use the build's architecture-specific operation lock and its child-process evidence.
Assembly records its store before creating roots. If assembly stops before image registration, inventory shows the
protected preparation so the same build can be retried.

Managed builds bind the selected manager's store under the Workbench cache. Matching bootstrap closures share one
database across projects and target architectures. A manager-wide lock serializes changes through image import. Profile
roots use separate project namespaces within the shared store. The Builders inventory measures the host directories
independently of Docker volume registration. Shared store measurements run separately from project totals. Profile pins
represent usage of the shared store.

Disposable Docker checks reopened real Nix and Guix storage after volume registrations were removed. The Guix check
verified both the package store and the daemon database.

Maintained tests cover profile-root ownership, interruption recovery, and preservation of neighboring and
architecture-specific pins. The native daemon and offline image runs below exercised the real managers and Docker.

Two independent Nix projects shared one managed store and verified their images offline. Removing the owned BuildKit
data, an image, and the Docker mount left profile roots on disk. The next preparation reopened the same store. Nix
collection removed the verified staging archives and the superseded profile while both current profiles remained usable.

Native x64 and emulated ARM64 Nix builds shared the same native manager and store, retained distinct target pins, and
ran the packaged program with networking disabled on both targets.

Two independent Guix projects and a replacement built and verified offline using the same managed store. Workbench
reused the authenticated bootstrap and reopened the store after both Docker volume registrations were removed. Guix
collected the superseded profile and staging archives while both current profiles remained runnable.

The host Guix daemon registered environment, runtime, and manager roots for two independent owners. Releasing one
owner's roots preserved the other owner's closure and the host's existing roots. A Nix daemon in a disposable container
exercised the native `nix develop --profile` registrations used by system preparation. Both projects selected the same
closure, and removing one project's dependency directory preserved the other roots.

## Implementing-agent detail

- Keep each manager's database, roots, and sandbox configuration together. Scope sharing to one user and a compatible
  local Docker engine. For an existing system daemon, release Workbench-owned roots only. The host operator controls
  global system-store collection.
- Revalidate current requirements, active preparations, explicitly retained profiles, and exact ownership just before
  releasing a pin or collecting a Workbench-owned store. Protect pending outputs through publication of their durable
  pins. Preserve the previous working state when a preparation or inventory fails. Publish recovery state before a move
  or removal.
- Retain durable project ownership across temporary checkouts. Identify interrupted builders using their own process and
  engine evidence. Show why an asset is protected and allow inspection of uncertain candidates.
- Keep existing prepared-image recipes and platform checks. Apply the same retention rules in CLI, automatic retention,
  and browser cache actions. Reuse fresh inventory results within one evaluated operation.

## Verification

- Check all three settings for each manager, including selection with the system daemon available and unavailable.
  Verify the managed location with a configured cache root, that disabled mode leaves both backends untouched, and that
  a backend failure preserves working profiles.
- Use two independent projects with overlapping packages. Verify cross-project and cross-architecture reuse, that
  pruning one project's pin preserves the other's closure, and that a concurrent prune preserves pending and explicitly
  retained outputs. Use configured emulation where needed.
- For each manager, prepare an image with a pinned profile from an empty managed store, then verify the image offline.
  Run container, image, builder, and volume cleanup against a disposable Docker engine. Recreate the builder and verify
  profile reuse. Prune the disposable test stores afterward.
- Report separately the shared-store bytes, BuildKit intermediates, and image layers. Exercise recovery of a stopped
  builder and preservation of a live or uncertain one. Verify that host-daemon cleanup only releases Workbench's own
  pins.
