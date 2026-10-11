---
summary: OS/environment matrices, example coverage, minima, isolated runners.
---

# ADR-10: GitHub continuous integration

GitHub projects run ADR-U's CI-stage gate on pushes and pull requests, with manual execution available. Use local
project commands. Ordinary runs may select affected roots from changed paths and declared dependencies, retaining each
root's complete matrix and suites. Documentation-only changes run validation and documentation checks without example
jobs. Unknown ownership or unavailable history selects all roots. Always retain validation and aggregate status.
Initial, release, and explicit full verification cover every root; commit gates retain complete proposed-tree checks.

Configuration owns supported platforms, native architectures, environments, and per-root coverage. Select environments
explicitly under ADR-Q; missing definitions fail. Check declared native pairs and selected Linux Guix, Nix, and Dev
Container environments. Consumers may narrow these choices; copied workflows are project-owned under ADR-1, while
explicit shared-definition and adapter references follow their distribution pin.

Workbench's native tooling and language examples support Linux x64/ARM64, macOS ARM64, and Windows x64. Windows ARM64 is
excluded pending equivalent native tooling, race, and sanitizer checks. Language examples exercise their declared
platform, environment, and compatibility matrices. Non-language examples, including frameworks, exercise only Linux x64
with selected development tools and declared managed environments, without additional language-version matrices.

Under ADR-9, use authoritative pins and explicitly test supported lines and minima that differ from development tools.
Coverage replaces ordinary execution of a suite only on configured targets; every required variant must have a matching
target. Other compatibility jobs retain ordinary tests.

Isolate untrusted changes, use read-only repository permissions and immutable action revisions, and bound job duration.
Keep failures visible without canceling independent jobs. Verification neither publishes releases nor changes pins. Keep
exact matrices, installation steps, notification settings, and cache mechanics in configuration and documentation.

Provide a Linux x64 rehearsal through the CLI and Makefile, defaulting to every configured Linux x64 target with
explicit subset selection. Share resolved checks, compatibility targets, and standalone release verification with hosted
CI. Isolate native and compatibility execution in containers; use configured launchers for managed targets. Expose
selections, exclusions, commands, and definition sources. Preserve the checkout and index, isolate build identities,
reuse verified caches, and keep disposable state outside the checkout. Retain reports and artifacts; independent targets
continue after failures. Never select emulation implicitly.

Rehearsals verify updates through isolated repository tests without publishing. Hosted platforms, permissions, OIDC,
registry authorization, and publication require applicable remote verification; local passes do not establish those
claims.

Rationale: CI makes environment compatibility observable while contributors keep a lightweight local workflow.
Independently pinned environments provide useful coverage without requiring identical package collections.
