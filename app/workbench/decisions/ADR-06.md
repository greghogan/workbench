---
summary: Exact presented versions, meaningful comparisons, review continuity, and preserved concurrent edits.
---

# ADR-6: Document review experience

CLI and browser review share the exact per-file acknowledgments and human authority defined by workbench:ADR-1. Format
records canonically under workbench:ADR-4 before presenting them for review; acknowledgment covers the presented
version. Reviewing does not stage or commit files.

Use the review baseline defined by workbench:ADR-1. A new record without a baseline is presented as a complete document.
Deletions show the complete version being removed. ADR comparisons retain full document context in unified and
side-by-side views. Paragraph reflow alone is not a word change; replacements group removals before additions.

Both presentations preserve the contents and ordering of each compared version. When detailed matching is unavailable,
present both complete versions with unmatched content explicitly identified.

A later on-disk change does not erase the user's ability to acknowledge the presented version. Make that change visible
and allow the user to load the newer version. Acknowledging older contents leaves newer changes pending. Keep a record
open while any of its files need review; otherwise remove it from the pending queue and continue to the next item.

Protected-document reviews and flagged policy incompatibilities share a unified review queue. Approval of a proposed
policy resolution authorizes that resolution; it neither applies the edits nor acknowledges their resulting contents.
Policy changes and compatibility reassessment retain their separate requirements under workbench:ADR-L.

Browser content editing supports charters, ADRs, and future plans; saves reject conflicting on-disk changes and preserve
unsaved input on failure. Other record types remain read-only in the browser except for explicit workflow actions.

Rationale: Exact independent acknowledgments preserve human control. Meaningful comparisons and continuity reduce the
attention required for review without confusing a changed file with what was actually presented.
