---
summary: Search note titles and contents locally, retaining ordinary links and keyboard navigation.
---

# ADR-1: Offline search and previews

Search titles and note contents without sending queries or documents to a remote service. Results include a short
excerpt and link to the complete note. Changing a note makes its updated contents searchable without a server restart.

Link previews supplement ordinary navigation. Keyboard users can follow the original link, dismiss a preview, and
continue reading. A preview must not trap focus or hide information available on the note page.

The [preview experiment](../experiments/EXP-01.md) describes the evidence still needed; the
[delivery task](../tasks/TSK-00.md) tracks the feature.

Rationale: Local search suits private notebooks, while progressive previews preserve familiar navigation.
