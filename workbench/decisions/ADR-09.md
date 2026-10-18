---
summary: CSL-JSON bibliographies, retained upstream metadata, acquisition states, and document storage.
---

# ADR-9: Citation records and source acquisition

Citation records use the `CIT` type code and are project-owned one-item CSL-JSON bibliographies under
`workbench/citations/`; they are not inherited. Keep acquisition metadata separately in the record's supporting
directory under ADR-4. Retain the exact upstream metadata used for import, with its source and digest, as provenance for
the editable bibliographic record. Preserve source identities, including arXiv versions. Project relevance belongs in
the records citing them.

Store acquired documents in the ignored library selected by `citations.library_dir`, initially `library/citations/`
relative to the owning project scope. Documents are not committed supporting files.

Published and preprint sources retain separate files and SHA-256 digests because their bytes may differ. Acquisition
states are `pending` (acquisition outstanding), `acquired` (document obtained), and `unavailable` (currently blocked
under available access conditions). Record the reason when known. Unavailability is reversible; explicit acquisition can
succeed later. Only acquired document sources have a digest. Transient download failures leave acquisition pending.

Fetch direct lawful sources or accept manual imports; leave authentication and access challenges to the user. Compute
and record acquisition digests, and never replace existing files implicitly. Keep source URL conventions, fields,
limits, and command procedures in the schema and records guide.

Rationale: Source-specific identities preserve acquisition provenance without redistributing papers or confusing
published and preprint versions.
