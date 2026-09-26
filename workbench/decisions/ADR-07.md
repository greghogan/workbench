# ADR-7: Citation records and source acquisition

Summary: Citation records preserve paper metadata and acquisition sources without redistributing source material.

Citation records chiefly enable acquisition of papers that the repository may cite but not redistribute. PDFs live in
a deterministic ignored directory. Project relevance belongs in records that cite the work.

Records use CSL-compatible YAML with `id`, `type`, `title`, and `author`, plus `issued` when known. They retain useful
publication metadata supplied by authoritative sources and a Workbench `sources` list for acquisition.

An arXiv source uses its canonical `https://arxiv.org/abs/<id>` URL; a DOI source uses
`https://doi.org/<doi>`. Both may be present, and arXiv version suffixes are preserved.

Workbench can create records from arXiv identifiers or DOI metadata. It fetches direct lawful sources and leaves
authentication or access challenges for manual import. Existing files are not replaced implicitly.

Each source has its own local PDF and SHA-256, since published and preprint bytes may differ. Fetch and import compute
the digest; a missing digest means acquisition is pending. All zeroes mean a source was confirmed unavailable, not
merely inaccessible to automation. Sync checks local files, fetches direct sources, and reports manual acquisition.

Workbench implements citation metadata and acquisition in `src/citation.rs`.
