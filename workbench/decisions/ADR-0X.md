---
summary: Immutable artifacts, digests, yanking.
---

# ADR-X: Release records and verified artifacts

Release records use the `REL` type code and are project-owned YAML documents under `workbench/releases/`; they are not
inherited. Retain notes, source revision and tag, publication date, and each artifact's target, filename, HTTPS URL,
size, and SHA-256. Published bytes are immutable; withdrawals mark releases yanked without removing them from maps.

Create records from published artifact identities, computing metadata from actual files. Build preparation follows
ADR-S; Workbench distribution follows ADR-3. Records document publication without controlling installation. Projects
without published artifacts need no release records. Keep creation order and derived-index procedures in the guide.

Rationale: Immutable source and artifact identities let consumers verify what was published and recover its rationale.
