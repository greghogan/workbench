---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-C: Add Java language support and a standalone reference

## Review summary

Add a reusable java definition and a standalone executable reference following workbench:ADR-9. Native tooling, managed
environments, compatibility, quality gates, releases, and update guidance are in scope. Implementation and local
verification are complete; ADR acceptance and hosted execution remain pending human review.

## Progress

- [x] Draft workbench:ADR-17 and select maintained runtime/tool pins.
- [x] Implement the reusable definition, standalone example, and strict checks.
- [x] Integrate verified native tools, caches, compatibility, managed environments, and release verification.
- [x] Add dependency-update guidance and behavioral regressions.
- [x] Review the changes and record applicable verification and limitations.

## Outcome

Consuming projects can select the shared java definition or replace it completely, copy the independent reference, and
use the same configured checks locally and in CI. Keep generated dependencies and builds outside the checkout.

## Verification plan

Verify configured checks and relocated release artifacts on Linux x64. Exercise manifest-derived support targets,
compatibility selection, source change ownership, verified installation, and isolated dependency storage. Preserve the
existing supported native platform set and managed environment adapters. Other operating systems and hosted publication
remain workbench:TSK-7; no push or publication is authorized here.

## Verification

All seven Java Linux x64 CI targets passed, including compatibility, Guix, Nix Docker, Dev Containers, and native
release relocation. The complete Workbench gate passed 317 tests and coverage floors. Negative probes verify missing and
mismatched cached Maven hashes and the Java 17 API target. Starter regressions also reject nested destination links
before copying. Both refresh skills passed metadata validation and canonical discovery. See
[verification evidence](../evidence/languages-java-javascript-20261010.json). Hosted platforms and publication remain
workbench:TSK-7. No commit, push, or ADR acceptance occurred.
