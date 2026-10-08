---
summary: CSL, arXiv/DOI, PDFs, digests.
---

# ADR-A: Citation records and source acquisition

Citation records chiefly enable acquisition of papers that the repository may cite but not redistribute. PDFs live in a
deterministic ignored directory. Project relevance belongs in records that cite the work.

Records use CSL-compatible YAML with `id`, `type`, `title`, `author`, `issued`, and a source URL. They retain useful
publication metadata supplied by authoritative sources and a Workbench `sources` list for acquisition.

An arXiv source uses its canonical `https://arxiv.org/abs/<id>` URL; a DOI source uses `https://doi.org/<doi>`. Both may
be present, and arXiv version suffixes are preserved.

Workbench can create records from arXiv identifiers or DOI metadata. It fetches direct lawful sources and leaves
authentication or access challenges for manual import. Existing files are not replaced implicitly.

Each source has its own local PDF and SHA-256, since published and preprint bytes may differ. Acquisition status is
`pending`, `acquired`, or `unavailable`; only acquired sources have a digest. Fetch and import compute the digest and
record acquisition. Unavailable means confirmed unavailable, not merely inaccessible to automation. Bulk acquisition
checks local files, fetches direct sources, and reports manual acquisition.

Rationale: Bibliographic metadata and per-source digests preserve acquisition provenance without redistributing papers
or confusing distinct published and preprint versions.
