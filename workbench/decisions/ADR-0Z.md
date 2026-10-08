---
summary: OS/environment matrices, minima, runner isolation.
---

# ADR-Z: GitHub continuous integration

Projects hosted on GitHub run ADR-D's CI-stage gate on pull requests and pushes, with manual execution available. Use
the same project commands as local checks, without filename filters. Select environments explicitly, ignoring
machine-local preferences under ADR-R.

Configuration declares supported operating systems, native architectures, and additional environments; registered check
roots determine language coverage. Run native checks for declared system/architecture pairs and Linux checks for
selected Guix, Nix, and Dev Container environments. Roots may explicitly narrow environment coverage; missing
definitions fail. Support for all three operating systems or either managed environment is optional.

Workbench's supplied native tooling and reference CI support Linux on x64 and ARM64, macOS on ARM64, and Windows on x64.
Exclude Windows ARM64 while its required tooling lacks native artifacts and equivalent race and sanitizer checks.

Coverage variants run only on their configured CI targets, replacing the ordinary execution of that suite. Validate that
each required variant has a matching matrix target. Compatibility and minimum-version jobs retain ordinary tests where
coverage is not selected.

Keep failures visible without canceling other matrix jobs. Explicit jobs test supported release lines and minima that
differ from development pins under ADR-B and its language specializations; read installation versions from each root's
authoritative selections under ADR-B.

Use isolated runners for untrusted changes, read-only repository permissions, immutable action revisions, and bounded
job durations. Verification does not publish releases or change pins. Repository rules may require these checks before
merging; CI status and configured GitHub notifications surface failures.

Keep installation details, matrices, and workflow locations in executable configuration and documentation; consumers
adapt the reference to their roots and deployment requirements.

Rationale: CI makes environment compatibility observable while contributors keep a lightweight local workflow.
Independently pinned environments provide useful coverage without requiring identical package collections.
