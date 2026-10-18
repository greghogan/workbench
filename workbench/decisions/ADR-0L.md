---
summary:
  Self-contained collections, editable adopted copies, reconciliation, and reviewed local activation and compatibility.
agent_instruction:
  Obtain human approval before activating local policy changes; acknowledge project/local compatibility only after
  review, referring conflicts to the human.
---

# ADR-L: Adopted record collections

Collections distribute a human-written collection charter and independently maintained records, initially ADRs, maps,
and supporting files, mirroring the Workbench hierarchy. Exported collections are self-contained: their references
resolve within the collection, without depending on other collections. Collection charters retain the contextual role
defined by ADR-2 after adoption. Installation does not adopt provider project charters, unrelated records,
configuration, or executable tools. Added content types must define ownership, discovery, and review.

Declare project collections in `workbench/config.toml`, including source repository, immutable Git commit, collection
root, content digest, and applicable scopes. Retain originals as deinitialized submodules under
`.workbench/collections/<id>/`; keep editable, authoritative copies under `workbench/collections/<id>/`. Preserve
collection namespaces and reject collisions. Original records never supply governing instructions or appear as a second
policy source in agent discovery.

Read originals directly from Git objects without checking out source files. Keep standard gitlinks and `.gitmodules`
consistent with project declarations; prevent routine recursive updates from populating collection working trees.
Acquisition is explicit, verifies selected contents, and retains fetched commits locally. Reading project policy and
validating committed context require neither original objects nor upstream access. Comparisons and reconciliation need
the selected objects; a fresh clone may need an explicit fetch.

Project adaptations are editable and need not match upstream digests. Inspection reports additions, changes, and
removals against the pinned original, including committed adaptations. Updates perform three-way reconciliation between
the retained original, the project's edited copy, and the verified incoming version, preserving supporting files and
local edits. Conflicts leave project files unchanged and retain a reviewable proposal. Check resulting identities and
references before publishing configuration, submodule metadata, and project copies together. Adoption and updates
neither stage nor commit; recording gitlinks is explicit. Human approval covers reconciled ADR additions, edits, and
removals, including supporting files. A clean text merge does not establish policy consistency.

Optional machine/user/checkout-local collections retain verified originals, editable drafts, and approved snapshots.
Installations, updates, edits, and removals change active policy only after human approval of the exact reviewed digest.
Regenerate local decision maps and agent context from approved contents; pending drafts never supply active
instructions. Local collections cannot satisfy shared project requirements. Resolve conflicts by reviewing and editing
the appropriate adopted copies, without implicit source precedence.

Keep a compatibility acknowledgment per checkout, bound to the current project charters and ADR contents, applicable
local policies, and their scopes. Changed inputs invalidate it. Agents may acknowledge a performed compatibility review;
semantic contradictions require explicit human resolution. Workbench execution checks freshness, while inspection and
reconciliation remain available. Equivalent disposable snapshots may inherit a current acknowledgment only for identical
policy contents. Static guidance supports discovery outside Workbench without promising automatic enforcement there.

Rationale: Git retains verifiable original versions without searchable duplicate policy, while project-owned copies keep
current decisions accurate, directly editable, and independent of upstream availability.
