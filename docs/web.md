# Local browser interface

[Workbench overview](../README.md).

Run the service to open the registered Projects dashboard:

```sh
workbench serve
workbench serve --port 8081
workbench serve --demo
```

Open the printed URL in your browser. The listener defaults to `127.0.0.1:8080`; `--host ::1` selects IPv6 loopback, and
`--port 0` selects an available port. Workbench does not launch a browser or configure SSH. Use your own browser and
forwarding arrangement when working on a remote host. Stop the service with Ctrl-C. Shutdown stops accepting work and
waits for admitted collection changes and cache deletions to finish. Read-only cache scans are cancelled on shutdown.

The dashboard lists registered consuming projects, including Workbench itself when registered. Open a project to browse
its records; **Projects** returns to the dashboard. Project records and adopted collections remain separate sources
within that project. Identical record IDs in different checkouts do not identify the same file.

Linked Git worktrees appear in an expandable list beneath their registered main checkout. Each link opens that
worktree's records; its **Cache** link opens checkout-specific cache management. Registrations, queues, and cache
ownership remain separate. The dashboard's sizes and cleanup actions apply to the named checkout; the **Caches** page
also lists worktrees individually. Independent clones remain separate projects even when they share a name. If the main
checkout is not registered, one registered worktree represents the group.

Use **Add project** or `workbench project add PATH` to register an existing checkout. The web form takes a directory on
the machine running the server, including when the browser connects through SSH forwarding. Initialization registers the
newly created project. An unfamiliar checkout asks before its first substantive interactive command; noninteractive
callers must register it explicitly. Declining blocks project operations and prints the manual registration command
without asking again. Registration is personal state and does not alter project files.

Project navigation is available while cache sizes load. Sizes refresh without replacing an active control or an
unfinished Add project form. Inventory events update measured cells directly; a slow directory does not hold back the
other measurements. The dashboard links each project's cache footprint to **Caches**. Referenced tool sizes can overlap;
the shared subtotal identifies installations used by multiple projects. The inventory counts an installation once and
shows its consumers, current protections, older versions, and retention choices. Build roots can serve several
subprojects, such as crates sharing one Cargo workspace. **Clear root** clears that shared build root together. Shared
package downloads are preserved; image layers may remain after their owned tags are removed. Filesystem and builder
sizes are estimates. Owned, eligible, and retained filesystem totals are shown separately from logical image footprints;
shared image-layer reclamation remains unknown. A failed inventory component reports its cause while other components
remain available.

Saved cache measurements survive server restarts and are reused while their directories are unchanged. Automatic
inventory refreshes are spaced fifteen minutes apart; explicit refreshes and cache maintenance can refresh sooner.
Recalculation keeps the previous estimate visible until a new value is ready and has no elapsed deadline. Use
**Recalculate sizes** on the Caches page after changes made outside Workbench. Locked or changing directories can retain
an older estimate. Size estimates never establish permission to delete. See
[storage and cleanup](tooling.md#build-and-dependency-storage).

Registry writes can be cancelled while waiting for another writer. After an interrupted writer,
`workbench project recover` releases a metadata lock only if its local process is provably gone; active, foreign, and
uncertain owners remain protected.

The trash button prepares a cache cleanup preview. **Remove** prepares a combined cache deletion and registration
removal. Both require reviewing and confirming the exact selection; changes invalidate the preview. Removal preserves
project files and needed shared installations. Active or explicitly retained project caches block removal. Incomplete
cleanup preserves registration. Successful removal records a declined state, preventing accidental re-registration.

### Demonstration

`workbench serve --demo` opens a disposable demonstration project with multiple examples of every record type, a
retained PDF, current record reviews, and ADR differences. **Open demonstration** on the dashboard opens
`/demonstration/` with a subtle **Demonstration** label. Direct demo links work without first opening the dashboard. The
header’s **Switch project** control returns to the normal Projects dashboard. Reopening the demonstration retains its
edits until the server stops. If its child process fails, the next visit reconnects using the existing demonstration
files; restarting the whole server resets the demonstration. Real projects and personal caches stay outside the demo
service. Collection preview fields select a bundled local repository, and external collection acquisition is rejected.

Demonstration sources live under `demo/` in the distribution. Each service session uses a private copy. Edits and
confirmations affect that copy; stopping the server discards them. Abrupt termination can leave temporary files for
manual removal.

This is a local, single-user interface with the invoking user's filesystem permissions. It has no shared-user login or
non-loopback listener. Browser requests protect the local origin and require an explicit acknowledgment for review or
collection application. Receipts remain cooperative acknowledgments, not authenticated signatures.

An empty project's overview provides onboarding guidance and **Create charter** links for registered scopes lacking a
charter. The form starts empty: the human writes and confirms authorship of the submitted text. Creation rejects an
existing or concurrently created charter and preserves the browser draft on failure. It neither generates intent nor
stages or approves the file. Run `workbench sync` after saving to refresh maps and agent context.

## Browse and follow records

**Tasks** under **Records** shows all task states as a hierarchy, with nested subtasks. The generated task map is an
index, not an execution queue. All four shared states (Planned, Approved, Accepted, and Canceled) have separate history
views with automatic loading and a **Load more** fallback. Global search includes every state. Invalid or missing
metadata remains visible under **Tasks needing attention**.

Task pages allow human plan approval, outcome acceptance, replanning, or cancellation. Each decision applies to the
exact displayed task version. **Task queue** under **Workflow** presents three sections on one page: **Plans** awaiting
approval, **Work** showing approved tasks and local execution progress, and **Outcomes** awaiting acceptance. Work keeps
the selected order and shows other approved tasks available to add. Move up/down buttons also work with the keyboard.
Readiness, blocking reasons, and verification evidence remain visible. CLI queue changes refresh connected browser
views. The queue survives a server restart and cache cleanup; it never changes Git staging or commits work. Agent
execution, including any permission to work in parallel, is directed through the developer's chat.

The project control in the header opens the **Projects** dashboard. **Switch project** appears beside the current
project name. The sidebar lists the project, its registered subprojects as an expandable hierarchy, and installed
collections. Selecting a name opens that source directly. The **Collections** link opens acquisition and update
controls. The Workbench wordmark is an identity label; **Overview** provides navigation back to the selected source.

Only declared subprojects appear in the tree; language check roots are independent. Nested scopes attach to their
nearest registered parent. Labels use each scope's optional `name`, falling back to its ID. Breadcrumbs use those same
names, such as `GraphAI/GraphMP`, and never insert intermediate directory names. Linked breadcrumbs above the page
heading return to parent sources and pages, including the review queue and record lists. Expand/collapse buttons support
the keyboard, remember disclosure choices for the browser session, and reveal the selected node's ancestors on
navigation. Links remain usable when JavaScript or browser storage is unavailable.

Record navigation and counts follow the selected scope or collection. A subproject shows records it owns; its parent and
children remain separately selectable. Header search spans the open project's records and subprojects, keeping
collections separate. Selecting a collection searches only that collection. Search is case-insensitive and includes file
contents. Its record-type selector defaults to **All types**; search results retain the query and selected type. Record
lists use this same header search rather than a separate form. It does not search other registered projects. A record
reference selects its owning scope. **Workflow** appears above **Records** and links the project's unified **Review
queue** and private **Task queue**, independently of the selected record source.

Lists load as you scroll, with an accessible **Load more** link as a fallback. **Load previous records** returns to
earlier entries, and the URL retains the current range for reload and browser navigation. Automatic loading pauses
before removing a focused row. Search matches identities, titles, metadata, and file text. Local collections are
read-only; adopted project copies remain editable. Collection charters supply context; the consuming project's charter
governs adapted decisions.

Read views show metadata directly with section headings. ADRs show **Summary** and **Agent instructions** when present;
tasks, experiments, environments, and releases show their relevant fields and relationships. Citations show titles,
authors, year, publication, identifiers, and other bibliographic details. Embedded HTML is displayed as text. Remote
images do not load. Links between registered documents open their record views; referenced record IDs also appear below
the document. Supporting Markdown files use the same formatted view and record previews. Breadcrumbs open the owning
record and its supporting folders; folder views list their files. Other text files retain source previews, and files can
be downloaded for inspection. Active file content is never executed in a record view. Individual text previews and
editable documents are limited to 2 MiB.

Citation dates display at their recorded precision, such as **2026-11-08** for a complete access date. Undated sources
omit the Year field.

HTML citations retain both original sources and extracted reader copies with separate checksums. **Original** opens an
isolated rendering of the complete source body. Remote images are blocked by default; **Enable images** permits HTTPS
images for that view. Explicit external links remain available, with referrers suppressed. Scripts, forms, frames, and
external styles remain blocked. **Download original** exports the exact acquired bytes.

Citation pages show whether each source document is present locally. **Read** opens a local copy and **Download** saves
it as a PDF or self-contained HTML file. Both actions appear only when a local copy exists. **Source** opens the
original source page. Read is an ordinary link, so the browser's **Save link as** action also saves the document. A
bookmarked document URL follows the original source if the local copy is later missing. Browsing never acquires missing
sources.

Webpage acquisition keeps the article's headings, emphasis, lists, quotations, code, tables, and figures, removes active
content and site navigation, and embeds supported images in a standalone HTML document. The library stores this document
with Brotli compression. Opening a copy verifies its recorded SHA-256; a mismatched file is rejected rather than
replaced. The ignored library is separate from record supporting files, so acquired sources can be locally missing after
cloning. Library changes refresh the displayed presence. PDFs support byte ranges; document responses support files up
to 256 MiB.

The service detects external edits and collection changes. Browsing uses the last complete workspace while refresh runs.
Routine refresh is silent; failure shows a notice while retaining the previous view. Recovery clears that notice without
removing draft or review warnings. Opening an editor or the review queue waits for a fresh view. Admitted saves and
confirmations finish during shutdown, including after a browser disconnects.

Task lists show subtasks beneath their parent and load more as needed. Parent context, expanded or collapsed branches,
and keyboard focus survive loading and refresh. Continuation links also work without JavaScript.

Restart the service after rebuilding or updating Workbench to activate the new server code.

Ordinary reading views update while preserving scroll position and keyboard focus where possible. An open editor,
review, or collection proposal instead shows a change notice and preserves its displayed contents. Refresh explicitly to
inspect the latest version. A disconnected live connection reports its state and reconnects automatically. Periodic
filesystem reconciliation recovers missed file-change notifications.

## Edit charters and decisions

Project-owned charters and ADRs provide an **Edit** view. Saving writes the submitted source exactly, including
comments; it does not format, stage, approve, or commit it. A save based on an older file version is rejected and the
draft remains in the editor. The browser warns before leaving a changed draft. Charters must be written by a human.

Other record types and published local collections are read-only. Use the existing record workflows to create records,
retain evidence, format documents, and regenerate maps and agent context with `workbench sync`.

The **Changes** tab appears when an ADR differs from its reviewed record or pinned upstream. Explicit comparison links
remain usable when unchanged and show **No changes**. Unavailable comparisons show their cause.

An ADR's **Changes** view shows the entire formatted document, including all unchanged context. **Unified** highlights
one removed passage followed by its replacement within each edited paragraph. Removed text is red and struck through;
added text is green and underlined. **Side-by-side** shows the complete previous and current documents with
corresponding blocks aligned and edits highlighted. Both layouts preserve headings, lists, tables, links, and the normal
Summary and Agent instructions sections. Soft line wrapping does not count as a word change. Raw Git diffs remain
available from the command line. Notices identify changed frontmatter comments and reference definitions, including when
paragraphs also changed. Column names remain available to assistive technology without visible labels. When fine
matching reaches its work limit, complete edited blocks remain visible and that fallback is identified. Project
decisions use the most recently reviewed contents since the last non-provisional commit, or that commit when no such
review exists. A new record without a previous review opens as a complete file instead of an empty-file comparison.
Reviews persist across server restarts; a new non-provisional commit becomes the baseline until another review occurs.
Adopted collection decisions also offer **Pinned upstream → project copy**, so committed adaptations remain visible.
**Adapted**, **Added to collection**, and removed-decision entries identify divergence; switch to **Compare with
reviewed record** to inspect changes since the automatic review baseline. Comparison reads verified retained originals
without fetching. Unavailable originals leave normal reading usable and explain the explicit fetch and refresh steps.

Formatted comparisons include frontmatter values and identify comment or reference-definition changes. Wide comparisons
scroll within the document panel. Other record types do not have a dedicated diff view.

While a form is submitting, its text stays selectable but cannot be edited until the response arrives. Failed requests
restore the controls and retain the draft. Completing one form does not discard unsaved entries in another; the page
stays open with a completion notice instead of navigating away.

## Review records

Open **Review queue** to review current records and their supporting files across the project, subprojects, and adopted
collections. Selecting a record source does not filter this queue. Record listings link **Needs review** tags to the
owning record, including when only its supporting files changed. Each record appears once in the queue, and each file
has its own acknowledgment. Reviewed files leave the queue; records remain only while they have unreviewed files. Later
changes return a record to the queue.

For an existing ADR, the review offers **Unified** and **Side-by-side** comparisons against the latest review since the
last non-provisional commit, falling back to that commit when there has been no subsequent review. Both comparisons show
the full content. A new record without a comparison baseline opens as a complete file. A deletion opens the complete
last-reviewed document, without an empty comparison column. Other Markdown records retain the applicable Previous and
Current views; supporting files show contents and offer downloads for binary inspection.

Record links use canonical scoped IDs: `/projects/PROJECT_ID/records/workbench:ADR-0` opens the record and its `/review`
subresource opens review. Supporting files use `/files?path=...`, and citation documents use `/document?source=...`.
Project identities are assigned at registration and survive `workbench project relocate PREVIOUS_PATH NEW_PATH` after
moving a checkout. Cold navigation and reload require no preceding dashboard visit. Explicit presentation choices,
including `layout=unified`, remain in links; omitting a choice means following the current default. Background event,
review-status, and inventory locations are supplied by the page rather than derived by browser controllers. Supporting
files retain independent exact-file acknowledgments within their record's review page.

Inspect the record and its supporting evidence, then select **Confirm new file**, **Confirm changes**, or **Confirm
deletion**. For a charter, confirmation also acknowledges human authorship. Use **Previous** and **Next** to move
between records. Confirmation keeps the record open while another file needs review, then advances to the next
unreviewed record. After the final item it returns to the queue.

The layout selector marks the current choice and preserves it when moving through the review queue. The server retains
the exact versions presented for review. If a file changes on disk, **Refresh** appears beside that file's **Confirm**
button. Refresh loads the latest contents without recording acknowledgment. Confirm acknowledges the displayed version;
if newer edits remain, the same record reopens with those edits compared against the acknowledgment. It advances only
after no review work remains for that record. Unrelated file changes do not interrupt review.

An old review page can expire after a restart or when the service needs room for newer presentations. Reload before
confirming an expired page; Workbench never substitutes the current disk file for the version shown. Recorded
acknowledgments persist across restarts. Files beyond the browser preview limit require terminal review.

Interactive terminal review likewise captures immutable current file contents before displaying them; later edits remain
pending rather than replacing the presented version. Neither interface requires staging before human review.

The commit gate independently requires review of the exact contents being committed. Reviewing a current file never
approves different contents selected for a commit. The web interface has no Git staging controls or review modes.

Concrete local/project incompatibilities appear in the same review queue as document changes. The compatibility item
shows affected ADRs, the agent's explanation, and its proposed resolution. **Approve resolution** records the human's
choice without changing the policy files; those edits still receive normal ADR review. **Dismiss finding** rejects a
false positive. Approval leaves execution blocked until the agent implements the resolution and records a fresh clean
compatibility assessment. The latest resolved findings and decisions remain inspectable from **Collections**.

A changed policy fingerprint requests agent reassessment and creates no human queue item by itself. Agents acknowledge
clean assessments through the CLI. Browser approval of a proposal does not acknowledge compatibility or establish that a
draft ADR has been accepted by commit.

## Add and update collections

**Collections** lists both project-adopted and local collections. A monitor icon distinguishes local collections in the
sidebar; their cards identify the installation scope and read-only status. Collections remain separate from project
search. Local collections are excluded from document review: their activation is approved at installation, while each
affected checkout separately acknowledges project/local compatibility. To add a project collection, supply its Git
repository, full immutable commit, collection directory, and audience. For an update, select an existing project
collection and the incoming revision.

**Prepare preview** explicitly acquires and verifies source objects and prepares the same reconciliation used by the
CLI. It leaves project files and the Git index unchanged. Inspect the proposed files, then select **Apply proposal**.
Application rechecks the exact proposed result and rejects stale proposals. It preserves project adaptations through the
existing reconciliation rules; conflicts retain a proposal for manual resolution using the CLI.

Application changes project files without staging or committing them, synchronizes generated project context, validates
the result, and opens the unified review queue. Preparation issues remain visible without misreporting the applied files
as unchanged. Review protected records there and acknowledge compatibility as appropriate. Browser previews expire after
15 minutes and when the service restarts. Oversized proposals require the CLI. Local policy preparation and activation
continue to use the existing CLI commands.

## Accessibility

References within record content and metadata show the target's scoped ID, title, and summary on hover or keyboard
focus. The preview remains available while hovered and closes with Escape. Links retain normal browser navigation;
record maps and record lists do not show reference popups.

Text follows browser font-size preferences, and narrow navigation wraps rather than requiring horizontal scrolling. Wide
document tables remain independently scrollable with the keyboard. Live updates retain focus on stable controls; if a
control disappears, focus returns to the main content.

The interface uses semantic navigation, labeled controls, keyboard focus indicators, text change markers, and a skip
link. It supports narrow windows, browser zoom, reduced motion, and forced colors. Live updates preserve active drafts
and do not silently replace a review snapshot. These provisions support the project's Section 508 requirement; a full
conformance claim requires the release-specific automated and human assessment described by ADR-18.

## Request failures

The local HTTP interface distinguishes invalid input (`400`), rejected origin or session (`403`), missing resources
(`404`), stale versions or concurrent operations (`409`), oversized requests or proposals (`413`), unexpected failures
(`500`), and a stopping service (`503`). Requests have an `X-Workbench-Request-Id` correlation identity. Unexpected
failures return a controlled message with that identity; operator diagnostics retain the cause. Stale saves preserve the
submitted draft. Action diagnostics distinguish requested work, confirmed completion, rejected requests, and unconfirmed
effects. A failed refresh after a confirmed action does not imply that the action failed. Expired reviews and previews
offer links to the appropriate page for recovery; those links navigate without repeating the failed action.

Cache updates retain displayed measurements during temporary network failures. Repeated connection failures, invalid
responses, and missing background endpoints show a refresh notice. A successful inventory update clears that notice.

The service reports watcher degradation and recovery, worker failures, and failed or recovered refreshes. It reports
stream failures and slow-client disconnections without logging form bodies, document contents, proposal tokens, or
request query strings. Ordinary browser live-connection closure is not an application failure. Structured diagnostics
from collection workers retain their severity; successful unstructured stderr is reported as a warning.

`GET /metrics` returns the versioned `workbench-web-metrics` snapshot. Counters are cumulative for one service lifetime;
duration totals and maxima use milliseconds. Ordinary HTTP durations include complete response handling and transfer;
`requestDurationSamples` is their count. Live connections have separate closure counts and duration totals/maxima.
Refresh totals/maxima measure the full refresh attempt, including failed attempts. HTTP status failures, refresh
failures, watch failures/recoveries, stream failures, slow-client disconnections, rejected connections, applied
mutations, prepared previews, action failures, and post-action refresh failures have separate counts. Gauges report
current watcher and collection-operation counts, refresh activity, and snapshot age in milliseconds; unavailable
snapshot age is `null`, not zero. Workspace capture and reuse counters distinguish fresh acquisition from cached reads.
Metrics use fixed names rather than record IDs or URLs as labels. These observations include instrumentation cost; debug
and persistent logging can add work.

Document reads reuse a complete in-memory workspace view while background reconciliation checks for changes. Concurrent
readers share refresh work. Review formatting uses the same captured bytes in the read worker; applying formatting still
checks the current file before changing it. Reviews continue to acknowledge the version actually presented.

CSS and JavaScript use content-versioned URLs, browser caching, and negotiated Brotli or gzip compression. Document
pages remain uncached in the browser. Original citation renderings reuse bounded server-side results only while the
verified source and its decoding metadata match; remote-image consent remains a per-view choice.

`Server-Timing` headers identify request preparation, rendering, and citation verification where applicable. The metrics
`phases` field reports fixed phase names with sample counts, total milliseconds, and maximum milliseconds; workspace
collection and formatting include worker time. These timings distinguish filesystem and Git acquisition from rendering
and transfer.

Run `workbench shell -- node scripts/check-web-browser.mjs --scenario "Document loading performance" --output DIR` from
a source checkout for repeatable cold/warm document navigation, concurrent reviews, asset-cache reuse, and invalidation
after an edit. The configured browser checks include this workflow. `performance.json` retains platform and browser
versions, corpus size, individual samples, medians, and ranges. CI summaries display timings from the current run.
Historical comparisons and timing thresholds are deferred; correctness assertions enforce freshness and cache reuse
independently of host speed.

`requests` counts responses that have finished or whose connection has ended, including live connections.
`requestFailures` counts HTTP status codes of 400 or higher; `requestAborts` counts interrupted non-live responses.
Capacity rejections count against `rejectedConnections`. Action failures include rejected or unconfirmed preview, save,
review, and application requests. Applied mutations and prepared previews count confirmed operation completions, not
unique changed records.

Collection installation and updates synchronize generated context and validate the resulting project through the same
service in the CLI and browser. Diagnostics distinguish already-applied files from preparation problems. Record
approval, staging collection references, and committing remain explicit actions.

## URL design background

ADR-19 keeps resource identities independent of storage and makes navigation work directly from a shared URL. Tim
Berners-Lee explains why addresses should survive implementation changes in workbench:CIT-1. Roy T. Fielding describes
hypermedia controls as the way clients discover available transitions in workbench:CIT-2. These sources explain the
design; the ADR states the project requirement. HTTP method semantics are defined in RFC 9110 (workbench:CIT-6).
