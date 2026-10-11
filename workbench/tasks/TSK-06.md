---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-6: Complete development and release profile design and implementations

## Review summary

Implemented named development profiles, managed Nix/Guix Dev Containers, nine independently selectable Go release
profiles, and shell completion installation. The root gate passed 239 tests; both managed containers passed the Go gate,
and all nine retained release receipts match current sources and artifacts. See
[verification evidence](../evidence/profiles-20261010.json) and the [profile guide](../guides/profiles.md). Hosted
verification and publication remain in workbench:TSK-7; draft ADRs and implementation still await human review.

## Progress

- [x] Named development profiles and local selection.
- [x] Managed Dev Container workspaces and builder ownership.
- [x] Release selection, isolated verification, and provenance.
- [x] Native, Nix, Guix, and Apptainer packaging examples.
- [x] Completion installation and documentation.
- [x] Behavioral verification and changeset review.

## Outcome

Provide the previously requested selectable development profiles and potentially multiple release targets using native,
Nix, Guix, and Dev Containers where appropriate. Document build policy before release policy and verify the supported
packaging workflows in the examples.

## Current state

Named development profiles, ignored local selection, managed Dev Container adapters, independent release selection,
isolated artifact verification, provenance receipts, and completion installation are implemented. The Go reference
provides nine native/Nix/Guix packaging profiles. Local Linux x64 verification is complete; hosted publication remains
in workbench:TSK-7.

## Implementation

Profile schema validation rejects unknown fields, duplicates, unsafe paths, missing verification commands, and invalid
builder/format/platform combinations. Explicit command selection overrides local preferences; development selection does
not redefine CI or releases. Container profiles select separate standard configurations and reject independent Features
for managed builders. Prebuilt development images require digest pins.

Release preparation defaults to all configured profiles and permits explicit subsets. It preserves existing outputs,
owns a preparation lock, verifies independent artifact copies outside the checkout, rejects changed artifacts or source
inputs, and accepts each successful directory atomically. Receipts retain artifact and source hashes, profile
configuration identity, locked builder inputs, native platform, and verification results. Failed profiles clean their
private staging while independent profiles may finish.

The Go example includes native binaries, Nix closure/portable/Docker outputs, and Guix relocatable/portable/Docker/
Squashfs/Apptainer workflows. The existing Nix lock supplies Apptainer because the pinned Guix channel lacks it. Nested
Apptainer verification is offline, uses user namespaces, extracts Squashfs without FUSE, and explicitly allows the
seccomp/system-path operations it needs. No CPU emulation or environment pin updates were used.

The human requested task review summaries and parent/child progress tracking during this work. The draft task ADR and
new task scaffold now provide Review summary and Progress sections. Linked child checkboxes/statuses synchronize from
authoritative records; ordinary inline steps remain manually maintained. Validation detects stale or invalid links and
Done tasks with unchecked steps, without automatically finishing parents.

## Findings

- Explicit `path:` Nix flake selection avoids Git ownership errors for a bind-mounted checkout while retaining locked
  inputs.
- Ubuntu 26.04 did not supply the Guix bootstrap package in the tested repository. The new Guix workspace uses a pinned
  24.04 base and its Guix package, with explicit daemon build users and network service definitions. Existing CI runner
  pins remain unchanged; hosted bootstrap verification belongs to workbench:TSK-7.
- Codeberg rejected fresh Guix channel acquisition from this host with HTTP 429. The local container test reused the
  existing cached checkout, copied to container-owned storage, and authenticated its pinned revision. Fresh-download
  behavior remains an external verification boundary.
- This host needs a scoped Docker host-network adapter for acquisition because its private DNS resolvers are unreachable
  from Docker's default bridge. Artifact verification continues to use offline containers; project network defaults were
  not changed.

- Real container checks found that workspace commands must use an ordinary user to preserve host cache ownership. Nix
  daemon selection belongs to client execution rather than the daemon's own environment. Nix's immutable account files
  are copied to writable image paths before creating its workspace user.
- The Guix bootstrap needs a UTF-8 locale to extract certificate filenames. Its cold pinned runtime build took about 20
  minutes locally. Nested Guix namespaces also need the explicit Docker system-path setting; hosted cache costs and
  first-use acquisition remain part of workbench:TSK-7.

## Validation

The complete root CI-stage gate passed all 239 tests across 50 files, including coverage floors, formatting, types,
lint, bundle parity, structural validation, shell/workflow checks, documentation examples, dependency advisories, and
credential scanning. Focused tests additionally exercise relative artifact links, mutation of file permissions,
immutable prebuilt images, inherited Feature rejection, reserved receipts, changing sources, and lock preservation. Both
Nix-managed and Guix-managed containers passed the complete Go commit-stage gate as ordinary workspace users.

An earlier default-all invocation prepared and verified all nine release profiles. After the final bootstrap changes,
eight managed profiles passed; the native profile correctly rejected a concurrent Go check lock and passed when retried.
All nine retained receipts match final source files and artifact identities. Detailed local logs are under
`/tmp/workbench-profile-*`; accepted artifacts remain under `dist/releases/`. Compact identities and limitations are
retained in [verification evidence](../evidence/profiles-20261010.json).

## Plan

Review and implement the draft build/release and development profile decisions. The authorized draft reorder puts the
build ADR directly before the release ADR and updates references together; its old-to-new mapping is retained under
`workbench/evidence/adr-order-20261009.json`. Implement requested profile selection, all-configured release default,
completion installation, and appropriate local/prebuilt Dev Container use with Nix or Guix owning compilers. Cover
container images, supported relocatable packs, Guix squashfs, and Apptainer workflows without complete-system
deployment. Prefer native architecture builders and flag any emulation for human review. Changes to Guix/Nix pins still
require explicit human initiation.
