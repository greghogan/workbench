# Work with records

[Workbench overview](../README.md). Commands assume your project root; `workbench` denotes the executable in your pinned
distribution.

## Records and maps

`workbench` prints context-sensitive help: project commands appear inside a configured project, including its
subdirectories. Explicit command help and the full catalog remain available outside projects. Add `--help` to any
command, use `workbench help record add` for a command path, or `workbench help --all` (also `--help-all`) for the full
public command tree.

Use `workbench record add TYPE TITLE` to create a task, decision, experiment, hardware environment, manual citation, or
release record. Creation allocates an ID, writes canonical metadata and paths, formats the result, and refreshes maps.
Read generated maps for navigation and use ordinary file tools to inspect or search records:

```sh
cat workbench/task-map.md
rg -n "parser" workbench
workbench record add task "Implement parser"
workbench record add decision "Parser contract" --project api
workbench sync
```

Creation selects the deepest registered scope containing the current directory; use `--project ID` to select another
scope. Examples using `--project api` assume that scope is already registered; a language check root alone does not
create a project scope. Hardware environment records describe execution hardware; development environments are
configured separately.

In record prose, `ADR-2` refers to the decision in that record's own scope; use `company:ADR-2` to name another scope's
decision. Structured relationship fields, including `parent`, `depends_on`, require scoped references. Imported
decisions retain their provider's namespace. Record numbers from different scopes do not imply ordering. ADR references
cannot form cycles, including across scopes; task dependency and completion relationships have their own cycle checks.
Contextual links between other records do not by themselves create dependencies.

Web record views provide previous and next controls beside the document, ordered by record identity within the same
scope and type. Review controls follow the pending review queue. Resolvable prose references become links with title and
summary previews on hover or keyboard focus; unqualified references resolve in the record's own scope.

Task creation accepts `--parent` and repeatable `--depends-on`; short IDs such as `TSK-0` resolve in the selected
project scope and are stored as qualified references. `record add citation TITLE` starts a manual bibliography entry;
prefer `citation add` when an arXiv ID or DOI is available. `record add experiment TITLE --protocol PATH` creates a
record from a complete protocol without executing it. `record add release PATH` creates a release from a specification,
as shown below.

Creation writes canonically formatted records and refreshes their maps. Decisions, environment records, and manual
citations start as drafts; creation reports the fields to complete. Environment drafts need hardware configuration and
limits. Manual citations need authors, an issued date or literal, an HTTPS URL, and a corresponding acquisition source.
For an undated source, use `"issued": { "literal": "n.d." }` and record the access date in `accessed.date-parts`.
Validation keeps these requirements and reports bibliography and acquisition problems together. Supply a task body from
a Markdown file or stdin when the content is already available:

```sh
workbench record add task "Improve parser" --from draft.md
cat draft.md | workbench record add task "Improve parser" --from - --project api
```

The input is the body below the task title, without frontmatter. Task metadata comes from the command's options.
Omitting `--from` creates the section scaffold. Directly editing a record is equally supported; format it and
synchronize maps before validation.

### Record metadata

ADR, TSK, EXP, and ENV files begin with a YAML mapping followed by the Markdown title and body. For example:

```markdown
---
status: Planned
---

# TSK-0: Improve parser

## Review summary

Explain why the work matters, what changes, and how the approach works. Summarize verification and remaining decisions;
use a visual when it helps the human understand the work. Keep implementation detail below this overview.

## Progress

- [ ] Implement the parser.
- [ ] api:TSK-1 (Approved): Verify parser behavior.

## Context

Describe the intended outcome.
```

Prose records use the workspace schema version. Their fields are:

| Type | Required metadata                               | Optional metadata                                                    |
| ---- | ----------------------------------------------- | -------------------------------------------------------------------- |
| ADR  | `summary`                                       | `agent_instruction`                                                  |
| TSK  | `status`                                        | `parent` (TSK reference or null), `depends_on` (TSK reference array) |
| EXP  | `status`, `environment` (ENV reference or null) |                                                                      |
| ENV  |                                                 |                                                                      |

Every prose type also permits an `extensions` mapping for project-specific metadata. Unknown top-level fields and
duplicate keys are errors. Omit `parent` for root tasks and `depends_on` when there are no dependencies; explicit `null`
and `[]` are also valid, respectively. References remain scoped, such as `api:TSK-4`. Task statuses are `Planned`,
`Approved`, `Accepted`, and `Canceled`; experiment statuses are `Planned`, `Running`, `Accepted`, `Rejected`, and
`Inconclusive`. Summaries and agent instructions contain one logical line of text; YAML folding may wrap their source
representation across physical lines. ADR references in summaries and agent instructions obey the same scope and
ordering rules as references in the body. Relative links retain their record-relative targets when summaries or
instructions appear in maps or generated context.

Experiment protocols also use frontmatter with `environment`. Creation supplies `status: Planned` and the record title,
checks the six protocol sections, and adds empty evidence sections. Citations use CSL-JSON with acquisition YAML;
release records use their separate YAML schema described below.

For example, write a protocol file before creating an experiment:

```markdown
---
environment: null
---

## Hypothesis

State the expected observable effect.

## Candidate and baseline

Identify what will be compared.

## Independent variable

Name the one intentional change.

## Controls and correctness

Define correctness checks and the conditions held constant.

## Workload

Specify inputs and repetitions.

## Evaluation rule

Set the rule for interpreting results before execution.
```

Then run `workbench record add experiment "TITLE" --protocol protocol.md`. Creation validates the protocol and leaves
execution and evidence collection to the project's experiment workflow.

Start a planned experiment with `workbench experiment start REFERENCE` or the record page's **Start experiment** button.
Protocol approval is not required. Refine the candidate and protocol within the authorized work, recording revisions
alongside the evidence they produced. Append execution provenance, evidence, and the decision after the protocol. Before
recommending rejection, assess whether reasonable design, implementation, or measurement improvements could change the
result. Explain which refinements were evaluated and the limits of the conclusion.

Finish with `workbench experiment finish REFERENCE --result Accepted|Rejected|Inconclusive`. The verdict describes the
candidate, not human acceptance of the work. Review completed evidence with `workbench experiment accept REFERENCE` or
the web review page. Completed records and each changed supporting file require human acknowledgment before commit;
unfinished plans and protocol revisions do not. Changes to already committed conclusions still require review, including
when reopening an experiment. Planned and running experiments appear under Work; completed results awaiting review
appear under Outcomes. A rejected or inconclusive candidate can still have a fully reviewed, complete experiment. Use
**Resume experiment** or `workbench experiment start REFERENCE` to continue refining a concluded candidate without
discarding earlier evidence.

Commit accepted experiments with their exact tested implementation; that commit identifies the candidate. For a
candidate not retained in source, link its applicable patch and baseline in the record. Do not add a self-referential
commit hash or duplicate a patch when the record's commit contains the tested candidate.

Microbenchmarks isolate a mechanism: exclude setup from the timed region and retain correctness results alongside
measurements. Workflow comparisons include the work needed for their end-to-end claim.

Tasks have four shared states: **Planned**, **Approved**, **Accepted**, and **Canceled**. Approving authorizes the
current plan; accepting confirms that its outcome meets the developer's expectations. A plan can stay Planned while it
is refined. Material changes return to planning. Task records contain a human-readable overview followed by
proportionate implementation details and verification evidence.

Keep unresolved recommendations distinct from agreed requirements. Record significant implementation decisions and their
reasons, distinguishing agent choices from human direction and retaining important rejected or deferred alternatives.
Include dates or other chronological context when they help explain a decision. Ordinary implementation choices within
approved scope do not need separate human approval unless another decision requires it. A concise entry is sufficient,
for example:

> Agent decision (Model A, high): share one artifact manifest between exports and publication to keep identity
> verification consistent. Separate manifests were rejected because they could disagree about the same output.

Include known model and reasoning settings in the decision entry, using information supplied by the harness or
delegation metadata. Omit unavailable details rather than guessing; identify multiple contributing models when relevant.
Model changes and commit squashes alone do not require new entries.

When a choice changes, update the affected plan and briefly explain the change. At completion, describe the actual
implementation, material departures from the plan, and verification results. Preserve significant reasoning, rather than
a conversation transcript. Move useful planning documents into the task or its supporting directory instead of
maintaining duplicate accounts under `docs/`; keep current user and architecture guidance in the normal guides.

The task schema allows one parent and multiple dependencies, rejects missing relationships and cycles, and keeps task
state authoritative over its checklist. The default task view and generated map preserve nesting; state history and the
local queue provide other orders. Finishing a parent requires its demonstrated outcome, accepted prerequisites, and
accepted or canceled children.

Web task lists show subtasks beneath their parent and load more as needed. Workflow phases preserve nesting and link to
parents in another phase; the selected execution queue retains its explicit run order.

`workbench task` lists unfinished plans and nested work. Use `--all` or `--status Accepted` for history,
`--project <id>` for a scope, and `--json` for structured output. `workbench task show <reference>` reads the full
record. Human decisions use `workbench task approve`, `accept`, `replan`, or `cancel` followed by the task reference.
`--expected <sha256>` binds a decision to the digest returned by `task show --json`.

`workbench queue` shows the selected local execution order and the next eligible task. Add approved work with
`workbench queue add <references...>` and reorder it with `queue move <reference> --before <other>` or
`--after <other>`. The queue records ordering, readiness, and progress; it does not schedule agents or select serial or
parallel execution. The developer initiates work in agent chat and may authorize a particular batch to run in parallel;
that permission applies only to the requested batch. `queue --ready --json` shows approved tasks with satisfied
prerequisites. There is no separate `next` command or command abbreviation.

The web task workflow presents Plans, Work, and Outcomes on one page. Plans await human approval; Work shows approved
tasks and their local execution progress; Outcomes await human acceptance. Document reviews and the task record browser
remain separate from this workflow.

Use `queue start <reference>` to claim work; `queue implemented <reference> --evidence "Checks and outcome"` records a
verified result pending acceptance. `queue block <reference> "Reason"` suspends work; `queue release <reference>`
returns it to queued and discards its local evidence. `queue remove <reference>` removes inactive work from the
selection. Shared-state changes retain a bounded recovery record while publishing record files, regenerated maps, and
finally queue progress. A later task mutation recovers interrupted publication; conflicting user edits stop recovery
with a diagnostic rather than overwriting them.

The queue persists under the native Workbench state directory, is never committed, and survives cache cleanup. These
commands coordinate work; they do not launch agents or commit, squash, or push changes. Publication restrictions are
workflow policy rather than an automatic inference of task ownership from arbitrary commits. Dependencies can be
accepted shared tasks or locally verified implementations in the selected batch. Parent acceptance waits for accepted or
canceled children. Publish implementation only after human acceptance; shared planning records may be published sooner.

Linked Git worktrees keep separate queue order, claims, and local progress. Recording an implementation also retains
repository-wide evidence bound to the task plan and complete Git-normalized source snapshot. Another worktree
automatically recognizes that evidence when the tested snapshot is a committed ancestor of its checkout and the plan is
unchanged. CLI and web views identify the source checkout, verification time, evidence, and committed baseline. This
establishes historical implementation, not fresh verification of later edits or human acceptance. Human acceptance still
requires accepted prerequisites and children. Evidence reuse does not copy active claims or infer human decisions.

Queue claims are exclusive and persist across restarts; updates reject stale ownership or task versions. Only tasks in
the selected batch are eligible. Local execution states are Queued, Active, Blocked, and Implemented; these do not
replace the four shared task states. Meaningful shared state and task-record changes belong with their related work;
local starts, blocks, and implementation reports do not require commits. See ADR-C for publication authority.

Earlier draft files using Active, Blocked, or Done need an explicit status edit before validation. Use Approved only for
an authorized plan and Accepted only for a human-accepted outcome; Done alone does not establish acceptance. Move
ongoing execution or blocking information into the local queue. Workbench does not silently migrate consuming projects.

Task Progress includes inline steps and linked child tasks. `workbench sync` derives a linked child’s checkbox and
status from its record; Accepted and Canceled children are checked, with their distinct status displayed. Ordinary steps
are manually updated. Validation rejects stale child statuses and Accepted tasks with unchecked steps. Completing the
checklist does not automatically complete the parent.

The task map includes unfinished tasks; other maps retain every record. Humans review new or changed ADRs before commit;
the commit accepts the reviewed text. Experiment and environment review follows the experiment ADR. Staging selects
files for a commit; it neither establishes nor proves human approval. Agents may implement and test within the
authorized scope while record review remains pending. Major features require human approval of a concrete plan before
implementation; that approval does not replace required record review before commit. Generated `AGENTS.md` needs no
separate approval.

Keep the substantive account of completed work in task files and summarize each commit's change in its message. Include
meaningful task-record updates with the work they describe; Git history of the record supplies that commit association
without a special message label or an embedded completion-commit hash. It identifies commits that changed the task
record, including record-only updates; it does not identify implementation commits that omitted that file.

Record filenames pad base-36 IDs to an even number of digits. Larger IDs use all preceding digit pairs as directories:
`app:ADR-0` resolves to `workbench/decisions/ADR-00.md`, and `app:ADR-100` to `workbench/decisions/01/ADR-0100.md`
within that scope. Titles retain the unpadded ID. `workbench/record-sequences.toml` reserves future IDs and must be
committed with records. Sync advances it for manually authored records; IDs are never recycled. A failed allocation may
leave a gap. The `workbench/.record-allocation.lock` directory records allocator ownership and prevents simultaneous
writers. Workbench recovers provably abandoned local ownership; uncertain locks require checking the recorded host and
process before manual recovery. Never remove a live allocator's lock. The current Git gate rejects deletion or
relocation of committed record files; ordinarily change their status or supersede them instead. Human-approved
migrations under ADR-4 preserve record contents and supporting material, retain the old-to-new identity correspondence,
and update references. Migration-aware gate support is required before relocating committed records through that
workflow.

Keep supporting files beside their owning record in a directory with the same filename stem. For example,
`workbench/decisions/ADR-00.md` may link a diagram at `ADR-00/design.svg`; the directory is
`workbench/decisions/ADR-00/`. This convention applies to every record type. Supporting files are not discovered as
records. Acquired citation PDFs and published release artifacts retain their separately configured storage.

After publishing immutable artifacts, `workbench record add release SPECIFICATION_PATH` computes their sizes and SHA-256
digests and creates a `REL` record. `workbench sync` derives `workbench/release-index.tsv`; setup does not use that
index to acquire the Workbench app.

The specification names local artifacts and their final published URLs; Workbench derives filenames, sizes, digests, and
the record ID:

```yaml
version: 0.1.0
revision: 0123456789abcdef0123456789abcdef01234567
tag: v0.1.0
released: 2026-09-20
notes:
  summary: First portable release.
  changes:
    - Add the checked-in Node bundle.
artifacts:
  - target: node22
    path: bundle/main.cjs
    url: https://example.org/releases/0.1.0/main.cjs
```

`workbench feedback` lists unresolved feedback, and `workbench feedback TEXT` searches it. Use `--all` to include
resolved feedback, `--json` for structured results, and `feedback show ID` to read a draft.
`workbench feedback add TITLE` creates a local uncommitted feedback draft in the user's data directory. Resolve it with
`workbench feedback resolve ID accepted|rejected EXPLANATION [--record REF]`; accepted feedback can link to a project
record when it becomes actionable.

The shared [filesystem policy](../workbench/decisions/ADR-0I.md) selects native locations for Linux, macOS, and Windows.
Linux uses XDG; macOS uses application-specific Library directories; Windows uses Known Folders, with local storage by
default and roaming storage only by deliberate choice. Feedback defaults to `$XDG_DATA_HOME/workbench/feedback` on
Linux, falling back to `~/.local/share/workbench/feedback` for unset, empty, or relative XDG values. On macOS it uses
`~/Library/Application Support/workbench/feedback`; on Windows it uses `%LOCALAPPDATA%/workbench/data/feedback`.
`WORKBENCH_DATA_HOME` explicitly overrides the Workbench data directory on every platform and must be absolute; feedback
then lives in its `feedback` subdirectory. Existing data is never moved automatically.

Project records stay under `workbench/`, and acquired PDFs stay in the configured project library. User tool
installations and caches follow the platform locations documented below; records remain project-owned. Hosted native
verification covers Linux x64/ARM64, macOS ARM64, and Windows x64.

Citation records preserve selected sources for later reference as standalone one-item CSL-JSON bibliographies. The
upstream input data model is described by the
[CSL-JSON schema](https://github.com/citation-style-language/schema/blob/master/schemas/input/csl-data.json). Use
ordinary links for regularly updated documentation and release information. Import metadata from an arXiv ID or DOI,
fetch an explicit direct source, or import a PDF obtained through a human browser flow:

```sh
workbench citation
workbench citation --missing
workbench citation add 1706.03762
workbench citation fetch
workbench citation fetch workbench:CIT-0 --source arxiv
workbench citation import workbench:CIT-1 ~/Downloads/paper.pdf --source published
```

Plain `citation` shows one row per source with the citation ID, title, source kind, local file presence, recorded
acquisition state, and whether a direct PDF URL is configured. It is read-only and does not create library directories.
`--missing` filters absent documents; `--project ID` and `--source KIND` filter the table. `--json` returns structured
rows with absolute original-document paths and a separate `readerPath` for HTML. Presence is not an integrity check;
fetching verifies stored PDFs against their recorded digests. An `acquired` source can be locally missing after a clone
because documents are ignored.

Without an ID, `citation fetch` verifies existing PDFs and acquires missing sources across all project scopes;
`--project ID` restricts it to one scope, and `--source KIND` limits the source kinds attempted. Use an explicit
citation ID to acquire a single source, with `--source KIND` when needed. Existing documents are verified without
replacement. Only new downloads receive individual output lines, using checkout-relative paths, followed by a summary.
Missing `download-url` metadata is reported explicitly; it does not establish that the paper is paywalled or requires
browser access.

IDs may be unqualified (`0` or `CIT-0`) or scoped (`workbench:CIT-0`). Unqualified IDs use the containing project scope,
unless `--project ID` selects another; an explicit scope must agree with `--project` when both are supplied.
`--source KIND` selects the `kind` label in acquisition metadata, such as `published`, `arxiv`, or `preprint`. Labels
are unique within a citation and are not a fixed global list. Fetching a single citation with several sources requires
an explicit source; bulk fetching considers every declared source unless filtered by kind. There is no separate `--kind`
option.

The `citation add` command requests CSL-JSON metadata and retains the complete response unchanged. The canonical record
keeps bibliographic fields, with the project citation ID and selected source URL. Acquisition state and upstream
provenance live in `acquisition.yaml` beside the record:

```text
workbench/citations/CIT-00.json
workbench/citations/CIT-00/
  acquisition.yaml
  upstream.json
library/citations/CIT-00-published.pdf   # ignored
```

`acquisition.yaml` has a `sources` array. Each entry identifies its `kind`, `landing-url`, optional `download-url`, and
`status`; only `acquired` entries have `sha256`. The optional `upstream` mapping identifies the original metadata's
relative `file`, optional source `url`, and SHA-256. Validation checks that the file exists and its bytes match.
Optional `reason` text explains an unavailable source; successful acquisition clears that obsolete blocking reason.

Automatic identifier import stores `upstream.json`. When preparing a citation through another tool, retain its original
input in the same supporting directory, for example `upstream.bib`, and identify it in `upstream`. Workbench does not
convert BibTeX itself. Manual records need no fabricated upstream provenance. Use `workbench record add citation TITLE`
for an incomplete starter, then fill its CSL-JSON and acquisition metadata. Notes and explanations belong in supporting
files, since JSON does not support comments.

Batch formatting includes the canonical JSON and acquisition YAML but leaves original upstream files untouched.
Synchronization adds a `.gitattributes` rule preserving citation supporting bytes across Git checkouts, without line
ending conversion. Fetch never bypasses authentication or CAPTCHA challenges. PDFs use source-specific names such as
`CIT-00-published.pdf` and `CIT-00-arxiv.pdf`. They live under `citations.library_dir`, initially `library/citations/`,
relative to each owning project scope; synchronization adds tracked `.gitignore` entries for that configured location.
These exclusions survive cloning. A citation may retain both published and preprint sources and their distinct digests.

Sources use these reversible states:

| State         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `pending`     | Acquisition remains outstanding.                                                             |
| `acquired`    | Document bytes have been obtained and their digest recorded.                                 |
| `unavailable` | Access is currently blocked under the available conditions; bulk fetching skips this source. |

A transient download failure leaves the source pending. Set `unavailable` explicitly when appropriate, recording the
reason when known. Reset it to `pending` to resume bulk attempts, or explicitly fetch or import the document to acquire
it directly. Unavailability makes no claim about future access. The generated citation map indexes bibliographic records
rather than local documents.

Citation metadata acquisition is limited to 1,048,576 bytes (about 1.05 MB), PDFs to 268,435,456 bytes (about 268 MB),
and each HTTPS redirect/download chain to five minutes. Failed or incomplete metadata is rejected; use
`record add citation TITLE` for manual entry.

For a webpage source, set `format: html` and a direct HTTPS `download-url` in `acquisition.yaml`; omitted `format` means
PDF. Fetching or importing HTML extracts and sanitizes the article, retains its semantic formatting, and embeds PNG,
JPEG, GIF, WebP, and AVIF figures. Failed or unsupported images prevent publication of an incomplete copy. Webpages are
limited to 8 MiB before extraction and individual images to 16 MiB; the completed document is limited to 256 MiB.

The library retains exact HTML source bytes as `CIT-00-published.original.html.br` and the extracted reader as
`CIT-00-published.html.br`. Both use Brotli compression. The source's `sha256` identifies the original bytes before
compression, decoding, or extraction; `extracted-sha256` identifies the compressed reader. PDFs retain one file and its
checksum. Downloads and manual imports use the same document limits, verification, and publication rules. Existing
sources and readers are verified separately; a changed source is never replaced implicitly. Retained originals can
supply a missing reader without reacquiring the source HTML, but extraction may still need remote images. Preserve both
library files in backups: changed images or extraction software can prevent reproducing the recorded reader checksum.
`charset`, when supplied, records its text encoding; `document-url` records the final URL used for resolving relative
references.

The web UI offers **Read** for the extracted document and **Original** for a safe rendering of the complete retained
HTML body. Original documents run in an isolated frame without scripts, forms, nested frames, or external styles. Remote
images are blocked until **Enable images** is selected. Ordinary external links remain clickable and omit referrers.
Image consent applies to that URL; reopening the original without the selection blocks remote images again. **Download
original** saves the exact source bytes, while **Download** on the citation page saves the self-contained reader.
Viewing a document never acquires source files or updates citation metadata.

## Experiment provenance and environment profiles

An ENV record can describe a single machine or a hardware family, such as AWS r8a. For a family, use its Configuration
profiles section to link inventories and relevant characterization measurements for each configuration. For example:

```text
workbench/environments/
  ENV-01.md
  ENV-01/
    r8a.2xlarge/
      capture-01/
        inventory.json
        characterization.json
    r8a.4xlarge/
      capture-01/
        inventory.json
        characterization.json
```

These names and formats are illustrative. For a single configuration, the ENV record itself can contain the profile.
When an experiment first uses a new configuration, add the inventory and profiling evidence relevant to its claims to
the existing family ENV. There is no required benchmark suite. Describe shared hardware characteristics and known
limits; family membership does not establish equal performance for the same allocated CPU count.

Each experiment's Execution provenance identifies the exact instance type or machine configuration, the ENV profile
capture used, available and allocated resources, and applied CPU or memory constraints. Record the OS release, running
kernel, and actual versions of the toolchains used. Link source, build, and dependency selections rather than repeating
facts fixed by the tested revision. A linked snapshot can serve multiple runs with identical execution context; each run
must resolve to the context actually used.

Software changes, including OS upgrades, can reuse the hardware ENV. Characterization captures also identify their own
software context. Add a new capture when relevant characteristics change, and preserve captures referenced by earlier
experiments. The same family ENV can therefore cover multiple instance sizes and software histories without treating
their measurements as interchangeable.

Use host inventory and profiling tools to capture hardware, OS, and kernel information. Capture project toolchain
versions and build selections separately; a host inventory does not establish which tools a run used. Link retained
reports from the ENV or EXP that owns them, using the supporting-directory convention above.

Human review covers changed ENV records, completed experiments, and their supporting files. Changes to previously
committed experimental conclusions also require review. `workbench review` presents current files and asks for approval
in an interactive terminal, independently of staging. Each acknowledgment covers the presented file version; additional
edits need another review. This uses the same receipt as ADR review; it does not require a separate environment approval
command.

## Curated source maps

A source map explains where implementation responsibilities live. Use a short index linking subsystem maps when a single
document becomes difficult to navigate. Directory entries are sufficient where finer detail adds little value.

Configure `source_map`, `source_paths`, and optional `source_excludes` in a `[[documentation]]` table in
`workbench/automation.toml`. Workbench validation checks entries against the selected source roots, reports uncovered or
missing paths and exact duplicate entries, and follows links to subsystem maps. Exclusions apply to a path and its
contents; overlapping directory and file entries are allowed. Standard generated directories such as `node_modules`,
`build`, `target`, and `coverage` are ignored.

Map authored TypeScript helpers rather than their optional emitted copies. An adjacent `.mjs` or `.cjs` file carrying
Workbench's `Generated from …; edit the TypeScript source.` header is covered by its mapped `.mts` or `.cts` source. The
source must exist and have its own file entry. Handwritten JavaScript still requires an entry; explicitly mapping a
generated file still requires that file to exist. Unpublished UUID-named atomic-write candidates are temporary state and
do not require source-map entries.

Start a bullet or the first table cell with a code-formatted project-relative path. Multiple leading paths may share a
responsibility. Start a bullet with a Markdown link to another map, relative to the containing map. Paths mentioned only
within explanatory prose are not entries. Source code remains authoritative; review the explanations when
responsibilities change. Counts and exhaustive per-file descriptions are unnecessary.

## Agent review evidence

Projects can require agent change review, accumulated task review, and human task decisions with `[review]` options
`changes`, `tasks`, and `task_approvals` in `workbench/config.toml`. Workbench enables all three. Consuming projects
choose which requirements to enable. Existing protected-record human review remains independent.

`workbench review` presents current protected records, including unstaged and new records, independently of Git staging.
It acknowledges the captured versions even when files change during confirmation; additional edits remain pending.
Subsequent review compares against the last acknowledgment made since the last non-provisional commit, or that commit
itself for previously accepted records. Provisional commits preserve pending review. Staging later requires no repeated
human review when those exact contents have already been acknowledged.

Review first checks record formatting. When reflow or other canonical formatting is needed, the CLI and web review page
show the proposed changes and ask before applying them. Formatting preserves the human's words and does not stage files
or acknowledge their contents; content review follows against the formatted version. Retained supporting files keep
their original bytes.

`workbench review changes` identifies current project files, including untracked implementation, and their baseline
without staging them. After reviewing and correcting the work, record its printed digest with
`--record --expected DIGEST --summary TEXT --verification TEXT`. The receipt becomes applicable when those exact
contents are staged. Select `--staged` explicitly when reviewing a partial commit. Use `--amend` when reviewing an
amended commit. `--task REFERENCE` explicitly associates work; changed approved task records and active queued tasks
also provide associations. Receipts are local, uncommitted Git metadata and contain no executable instructions.

Before publication, use `workbench review task --base REVISION` with the same recording options to assess the
accumulated outgoing work against the destination's current tip. After fetching and rebasing, collaborators' commits
form the baseline; their local receipts are not required. The commit hook checks local change review, and the push hook
checks the accumulated outgoing review. File content, mode, path, and baseline changes invalidate the applicable review.

Each worktree retains only its latest change review and accumulated review. New reviews replace superseded receipts; the
post-commit hook releases change evidence after a successful commit. Explicit task associations remain attached to
pending branch work, including after a rebase; consuming a receipt cannot remove an acceptance requirement. The hook
uses the committed Workbench distribution or the installed command, independently of unstaged launcher changes and
project registration. Failed pushes can reuse matching accumulated evidence. A later push that observes the reviewed
snapshot at the destination retires that receipt; otherwise a newer accumulated review replaces it. Observing published
branch work also retires its pending associations. Human file acknowledgments and task decisions are stored separately.

With human task decisions enabled, task approval and acceptance require confirmation through the interactive task CLI or
task page. Local implementation commits may precede acceptance. Acceptance captures the current project files through a
private Git index and preserves the real index. Publishing associated implementation requires Accepted task records and
decisions covering the final project snapshot. Further changes require renewed acceptance. Planning records can be
published before implementation approval. Review receipts attest the reviewer's assessment; they do not authenticate a
human identity or prove review quality.
