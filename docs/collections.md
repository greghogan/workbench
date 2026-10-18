# Adopt and reconcile collections

Independent providers supply collections containing a human-written charter, self-contained ADRs, their decision map,
and supporting files. The published charter describes the collection's purpose and boundaries and governs the provider's
published ADRs. After adoption it remains context and provenance: the consuming project's own charter governs its
adopted and adapted ADRs. Adapting an ADR does not require changing the published charter.

Workbench provides collection tooling; its executable distribution does not bundle third-party policy. The project owns
editable copies; original versions remain in deinitialized Git submodules. Only the project copies supply governing
policy. Review and adapt tool-specific requirements during adoption; using record conventions alone does not require
Workbench.

## Adopt from a Git commit

From the consuming repository:

```sh
workbench collection install https://github.com/OWNER/standards.git --commit FULL_COMMIT --scope project
workbench sync
workbench validate
```

The source can be an exported collection committed in a Git repository, or a Workbench project's root ADR scope. Use
`--collection PATH` when the source resides below the repository root, such as `policy/engineering`. The default is `.`.
For a root scope without an export manifest, `--visibility public|private` declares its audience; the default is
private. An export manifest retains its declared audience. `--sha256 DIGEST` additionally checks an independently
selected content pin. References must resolve within the selected collection. The source must include its human-written
`workbench/CHARTER.md`; adoption preserves its bytes as collection context. Provider tasks, configuration, and tools are
not adopted. Local source repositories must use absolute paths; use accessible HTTPS/SSH URLs for shared projects.

Workbench fetches the exact commit into Git object storage and verifies selected files without checking them out. Signed
commits require successful `git verify-commit` using the caller's configured Git signature verifier and trust material;
verification failure blocks acquisition. Unsigned commits rely on the reviewed commit and content pins, with no upstream
signature to authenticate. Credentials belong in Git's runtime credential facilities, never source URLs or tracked
files.

Declarations live in `workbench/config.toml`:

```toml
[[collections.sources]]
id = "company"
source = "https://github.com/OWNER/standards.git"
commit = "FULL_IMMUTABLE_GIT_COMMIT"
collection = "."
revision = "COLLECTION_REVISION"
sha256 = "RECORDED_CONTENT_SHA256"
visibility = "private"
scopes = ["."]
```

These placeholders are descriptive, not valid pins. Scope paths name registered projects. Namespaces must not collide
with project or other collection namespaces. Configuration owns the selection; gitlinks record the same commit and
`.gitmodules` records matching source metadata with `update = none`.

```text
.workbench/collections/company/                # Submodule path, absent or empty
workbench/collections/company/decisions/        # Editable project policy
workbench/collections/company/decision-map.md   # Generated from project copies
workbench/collections/company/CHARTER.md        # Published purpose and boundaries; contextual after adoption
.gitmodules                                    # Standard Git source metadata
```

`.workbench/` is not globally ignored. Original contents reside in Git's object storage, outside ordinary working-tree
searches. Workbench never initializes a collection working tree. If one was populated manually, preserve any work and
explicitly deinitialize it before changing the selection. Source and consuming repositories must use the same Git object
format, as required by their gitlinks.

## Review and stage

Adoption and updates leave the Git index untouched. Deinitialized submodules have no checked-out `HEAD` for ordinary
`git add` to discover a new selection. After reviewing the proposed files, explicitly stage their gitlinks:

```sh
workbench collection stage company       # Omit the ID to stage all configured collection gitlinks
git add .gitmodules workbench
```

The helper verifies all selections before staging their gitlinks together and creates their empty submodule directories.
It preserves unrelated index entries. Stage other reviewed files, including generated agent guidance and skills, with
ordinary Git commands. Obtain human approval of reconciled ADR additions, edits, removals, and supporting files before
committing; clean merges still require approval. Commit gates check staged gitlinks against the proposed configuration.
Source-commit updates remain separate from executable updates.

## Compare and reconcile

A normal clone contains the authoritative records and can read, edit, regenerate, and validate project context without
fetching collection originals. Comparison requires original objects. Fetch them explicitly when needed:

```sh
workbench collection fetch company
workbench collection changes company
workbench collection compare company --commit NEW_FULL_COMMIT --include-private
workbench collection update company --commit NEW_FULL_COMMIT
```

`fetch` retains the pinned objects locally without creating a working tree or changing selections. `changes` reports
project additions, edits, and removals, including committed adaptations. `compare` reports upstream changes without
changing project files; private policy text requires an explicitly private audience. Updates and comparisons acquire
selected commits as needed. An optional repository argument changes the upstream source deliberately.

`update` reconciles the retained original, current project files, and new upstream files. Conflicts leave project files
unchanged and retain a temporary proposal of records and supporting files, plus a conflict report. Edit that proposal,
then repeat the same update with `--resolved /path/to/proposal`. Resolve binary and delete/edit conflicts explicitly;
text conflicts contain merge markers. Keep the same candidate commit and collection while resolving it. The temporary
report fingerprints the project records and supporting files; further project edits make that proposal stale. Preserve
your resolution and start a new reconciliation rather than overwriting intervening work. Generated decision maps are
rebuilt from the reconciled records and are excluded from text merging and adaptation reports. Published charters are
included in comparisons, conflict proposals, and reconciliation, preserving local human edits. Their contextual role
does not exempt them from human authorship and review requirements.

After success, run `workbench sync` and `workbench validate`. Review policy consistency even after a clean text merge,
then explicitly stage gitlinks and the reviewed files. Fetched commits are retained by local Git references; another
clone may need to fetch them from the configured source. Missing originals never silently substitute another version.

## Export and local guidance

Providers can explicitly export selected ADRs and their supporting files together with their human-written charter:

```sh
workbench collection export /tmp/company-export --id company --revision 1 --all --visibility private
workbench collection inspect /tmp/company-export
```

Export copies the selected project's existing `workbench/CHARTER.md` unchanged. If the collection has a different
declared purpose, supply an appropriate human-written charter with `--charter PATH`; relative paths resolve from the
project root. Workbench never generates charter text. Missing or empty collection charters prevent publication and
adoption. The export inventory checksums the charter along with the records and supporting files.

Early development collections without a charter need an explicit transition before use with this contract. Preserve
their immutable snapshots and any local edits. Prepare a replacement export with a human-written charter in a separate
directory, then review its contents and selected inventory before activation. Normal reconciliation requires a valid
retained snapshot, so a charterless installed revision needs a reviewed registry migration; changing the original
snapshot in place is unsafe. Workbench does not invent missing charter text or silently relax the inventory requirement.

Commit an export into its provider repository before adopting it as a project submodule. Export destinations are never
replaced in place. Collections cannot depend on other collections. Installation does not authorize redistribution;
private policy requires an explicit permitted audience for export.

The export manifest `workbench/collection.toml` records one collection ID, revision, visibility, a `decisions` list of
canonical ADR numbers, and the checksummed file inventory. It declares no additional namespaces or dependencies.
Provider source directories need no revision component; Git tracks their history. Versioned installation directories
retain immutable exports and approved snapshots separately from those sources.

## Local policy activation

User, system, and ignored checkout installations accept local exports with a recorded `--sha256` and
`--scope user|system|local`. Installation prepares an editable draft without changing the active policy. For example:

```sh
workbench collection install /tmp/company-export --scope user --sha256 SHA256
workbench collection local review company
workbench collection local approve company --digest REVIEW_DIGEST --human-approved
```

`--human-approved` records an explicit human acknowledgment of the exact reviewed changes. Agents use it only after
receiving that approval; it does not authenticate a person's identity. Inspection exposes proposed text, supporting-file
hashes, upstream identity, and the activation digest. Changed candidate policy or active selections invalidate that
digest. Previously active selections remain active while replacements are prepared.

Within the selected collections directory, `.originals/ID/REVISION/` retains verified provider exports;
`.drafts/ID/workbench/` contains the contextual charter, editable ADRs, and supporting files. Approved snapshots have
content-derived revisions under `ID/REVISION/`; `index.toml` selects them. Edit drafts, review, and approve to activate
adaptations. Updates use the same three-way merge as project adoption. Repeat installation with the incoming export and
checksum to prepare an update. Conflicts retain a proposal and preserve both the draft and active policy; repeat with
`--resolved PROPOSAL/resolved` after resolving it. Reviewed source and draft changes invalidate old proposals.

All local commands accept `--scope user|system|local` and `--directory PATH` for custom user/system locations. System
locations require the corresponding filesystem permissions. `collection local remove ID` stages removal for review and
approval; `collection local retain ID` cancels that pending removal. Removal preserves originals, approved snapshots,
and editable drafts, including unapproved work.

## Local context and compatibility

Each installation has a generated `AGENTS.md` with the active policy fingerprint, instructions, and relative links to
its decision maps. `collection local sync` explicitly repairs generated context and creates an empty context when no
collections are active. Approval rebuilds context automatically. Local drafts do not appear in active context.

Collection decision maps and agent context link the published charter with an explicit contextual label. Generated agent
context embeds only the consuming project's own charters; it never presents a provider's charter as a second governing
charter.

A user-level `AGENTS.md` links installation-owned contexts, including system contexts when present, and explains
checkout-local discovery. The launcher installer and local collection operations create it. Its native defaults are:

| Platform | User context entry point                                                            | Compatibility receipts                                                                           |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Linux    | `$XDG_DATA_HOME/workbench/AGENTS.md` (default `~/.local/share/workbench/AGENTS.md`) | `$XDG_STATE_HOME/workbench/policy-reviews/` (default `~/.local/state/workbench/policy-reviews/`) |
| macOS    | `~/Library/Application Support/workbench/AGENTS.md`                                 | `~/Library/Application Support/workbench/state/policy-reviews/`                                  |
| Windows  | `%LOCALAPPDATA%/workbench/data/AGENTS.md`                                           | `%LOCALAPPDATA%/workbench/state/policy-reviews/`                                                 |

`WORKBENCH_DATA_HOME` and `WORKBENCH_STATE_HOME` explicitly replace those Workbench directories. Committed `AGENTS.md`
contains portable discovery instructions. Project policy remains readable without an installed executable.

Before project execution, inspect and review the active local policies alongside the project charters, ADRs, and
supporting material. An agent may perform this review and acknowledge compatibility; refer contradictions to the human
for resolution. Human approval of protected record changes remains a separate `workbench review` operation.

For the working tree:

```sh
workbench collection context
workbench collection compatibility
workbench collection compatibility acknowledge --digest COMBINED_DIGEST --reviewed
workbench collection compatibility check
```

For a proposed commit, add `--staged` to compatibility inspection, acknowledgment, and checking. Read proposed record
contents from the Git index, for example with `git show :workbench/decisions/ADR-00.md`. Unstaged edits never enter that
acknowledgment. A working-tree review may be reused for an identical staged policy set; differing unstaged policies
require their own review before working-tree checks.

Compatibility acknowledgment is an agent or human attestation of an actual review; it does not automatically prove
arbitrary prose consistent. Human approval of local activation does not establish compatibility with every project. The
receipt binds current authoritative policy contents and applicability to that checkout. Project charter/ADR or
supporting-file changes and activated local policy changes invalidate it; unrelated application changes and pending
local edits do not. Contextual collection charter changes affect collection integrity and reviewed snapshot identity,
but do not change the policy compatibility fingerprint. Identical policies may be deduplicated. Differing copies of the
same namespace block acknowledgment; semantic contradictions between different namespaces require explicit human
resolution by editing the appropriate copy. No implicit source precedence resolves conflicts.

Workbench execution entry points reject stale reviews and generated contexts. Inspection, editing, and reconciliation
remain available to resolve them. Local CI can transfer an existing review into disposable snapshots only when policy
contents match exactly; relocated frozen contexts retain their fingerprints. Empty local selections need no receipt.
Managed subprocesses inherit the performed host review when the project policies are unchanged and every local policy
visible in the guest matches reviewed contents. Host-only policies need not be installed in the guest; new or changed
guest policies require review. This is cooperative review evidence, not authenticated proof of human identity. Outside
Workbench, agents follow the context discovery and freshness instructions. Static Markdown cannot observe arbitrary
commands or automatically detect edits; harness or shell integrations can invoke `compatibility check` for stronger
enforcement. No shell integration is required.
