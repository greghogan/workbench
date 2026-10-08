---
summary: Immutable artifacts, digests, yanking.
---

# ADR-Y: Release records and verified artifacts

A release record contains notes, source revision and tag, publication date, and each artifact's target, filename, HTTPS
URL, size, and SHA-256. Published bytes are immutable; mark a withdrawn release as yanked.

Create the record after tagging and building so Workbench can compute artifact metadata; commit it after the tag if
necessary. Release maps retain withdrawn versions.

Workbench distribution follows ADR-5. Release records document published artifacts without controlling installation.

Projects without published artifacts need no release records. `workbench/release-index.tsv` is derived from them.

Rationale: Immutable source and artifact identities let consumers verify exactly what was published and recover its
rationale.
