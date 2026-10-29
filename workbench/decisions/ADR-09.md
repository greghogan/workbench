---
summary: Preserved sources, bibliographic metadata, acquisition provenance, and document storage.
---

# ADR-9: Citation records and source acquisition

Citation records identify material whose particular contents the project intends to preserve and revisit. Regularly
updated documentation and release information use ordinary links.

Citation records use the `CIT` type code and are project-owned bibliographies under `workbench/citations/`; they are not
inherited. Use a standard, interoperable bibliographic format. Keep acquisition metadata separately in the record's
supporting directory under ADR-4. Retain the exact upstream metadata used for import, with its source and digest, as
provenance for the editable bibliographic record. Preserve source identities, including arXiv versions. Project
relevance belongs in the records citing them.

Store acquired documents in the ignored library selected by `citations.library_dir`, initially `library/citations/`
relative to the owning project scope. Documents are not committed supporting files.

Retain acquired source bytes separately from derived reading copies and record digests for both. Source identity is
independent of storage compression. Published and preprint sources retain separate files and digests because their bytes
may differ. Acquisition states are `pending` (acquisition outstanding), `acquired` (document obtained), and
`unavailable` (currently blocked under available access conditions). Record the reason when known. Unavailability is
reversible; explicit acquisition can succeed later. Only acquired document sources have a digest. Transient download
failures leave acquisition pending.

Fetch direct lawful sources or accept manual imports; leave authentication and access challenges to the user. Compute
and record acquisition digests, and never replace existing files implicitly. Keep source URL conventions, fields,
limits, and command procedures in the schema and records guide.

Rationale: Preserved sources keep project reasoning and evidence revisitable. Source-specific identities retain
acquisition provenance and distinguish published and preprint versions.
