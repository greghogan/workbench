# ADR-M: Release records and verified artifacts

Summary: Release records join notes and immutable source identity to verifiable published artifacts.

A release record contains notes, source revision and tag, publication date, and each artifact's target, filename, HTTPS
URL, size, and SHA-256. Published bytes are immutable; mark a withdrawn release as yanked.

Create the record after tagging and building so Workbench can compute artifact metadata; commit it after the tag if
necessary. Release maps retain withdrawn versions.

Consumers pin the Workbench source containing its runnable Node bundle. Release artifacts may additionally be
published with sizes and digests, but setup does not select or download an executable.

Projects without published artifacts need no release records. `workbench/release-index.tsv` is derived from them.
