---
summary: Immutable artifacts, digests, yanking.
---

# ADR-X: Release records and verified artifacts

Release records use the `REL` type code and are project-owned YAML documents under `workbench/releases/`; they are not
inherited. Retain notes, source revision and tag, publication date, and each artifact's target, filename, HTTPS URL,
size, and SHA-256. Published bytes are immutable; withdrawals mark releases yanked without removing them from maps.

Use the verified outputs from ADR-S for artifact delivery and tagged release publication. An official release binds
published artifacts to reviewed tagged source. Reuse CI evidence when it matches the published bytes. Create its record
from actual published artifact identities. Keep creation order and derived-index procedures in the guide.

Rationale: Immutable source and artifact identities let consumers verify what was published and recover its rationale.
