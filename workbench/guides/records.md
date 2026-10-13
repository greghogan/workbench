# Work with records

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

## Records and maps

`workbench` prints command help. Add `--help` to any command, use `workbench help task add` for a command path, or
`workbench help --all` (also `--help-all`) for the full public command tree.

Each record type has a direct command: `task` (`TSK`), `decision` (`ADR`), `experiment` (`EXP`), `environment` (`ENV`),
`citation` (`CIT`), and `release` (`REL`). Environment records describe hardware; check environments are configured
separately in `workbench/config.toml`.

```sh
workbench task                               # List open tasks across all scopes
workbench task parser                        # Search tasks for the literal text "parser"
workbench task parser --all                   # Include completed and canceled tasks
workbench task --status blocked               # Select one task status
workbench task show 0                         # Read TSK-0 in the current scope
workbench task add "Implement parser"         # Create a task in the current scope
workbench decision retry --project api        # Search one scope's decisions
workbench search parser --all                 # Search every record type, including task history
workbench sync                               # Refresh generated files after manual edits
```

Bare record commands list records; following text searches their full contents without regard to case. Multiple words
form one literal phrase. Use `task -- add` to search for an action name, or `task -- --flag` for text beginning with a
dash. Everything after `--` is literal search text; place options before it, as in `task --all -- add`. The same pattern
works for every record type. Only task browsing hides finished records by default: `--all` includes them and
`--status done` selects a specific status. Experiments also accept `--status`.

Browsing covers all registered scopes unless `--project ID` is given. Creation and short IDs select the deepest
registered scope containing the current directory, falling back to the root scope outside the project. Override that
choice with `--project ID`, or pass a scoped reference to `show`, such as `workbench task show api:TSK-0`. `show` also
accepts a type-prefixed ID such as `TSK-0`. Scoped references must agree with an explicit `--project`.

Lists, searches, and `show` support `--json`. Search results normally occupy one line per record; `--matches` includes
matching lines. Global `search` also accepts `--type task` or a record code such as `TSK`. Record files remain in the
checkout after completion or obsolescence, so references and searches work without accessing version-control history.

Use `task add`, `decision add`, or `environment add` with a quoted title. Task creation accepts a scoped `--parent`
reference and repeatable scoped `--depends-on` references. `citation draft TITLE` starts a manual bibliography entry;
prefer `citation add` when an arXiv ID or DOI is available. `experiment add TITLE --protocol PATH` creates a record from
a complete protocol; it does not execute the experiment. `release add PATH` creates a release from a specification, as
shown below.

Creation writes canonically formatted records and refreshes their maps. Supply a task body from a Markdown file or stdin
when the content is already available:

```sh
workbench task add "Improve parser" --from draft.md
cat draft.md | workbench task add "Improve parser" --from - --project api
```

The input is the body below the task title, without frontmatter. Task metadata comes from the command's options.
Omitting `--from` creates the section scaffold. Directly editing a record is equally supported; format it and
synchronize maps before validation.

### Record metadata

ADR, TSK, EXP, and ENV files begin with a YAML mapping followed by the Markdown title and body. For example:

```markdown
---
status: Planned
parent: null
depends_on: []
---

# TSK-0: Improve parser

## Review summary

Describe the intended change, verification status, and remaining decisions.

## Progress

- [ ] Implement the parser.
- [ ] api:TSK-1 (Active): Verify parser behavior.

## Context

Describe the intended outcome.
```

Prose records use the workspace schema version. Their fields are:

| Type | Required metadata                                                              | Optional metadata                                      |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| ADR  | `summary`                                                                      | `agent_instruction`, `overrides` (ADR reference array) |
| TSK  | `status`, `parent` (TSK reference or null), `depends_on` (TSK reference array) |                                                        |
| EXP  | `status`, `environment` (ENV reference or null)                                |                                                        |
| ENV  |                                                                                |                                                        |

Every prose type also permits an `extensions` mapping for project-specific metadata. Unknown top-level fields and
duplicate keys are errors. Empty relationships use `null` or `[]`; references remain scoped, such as `api:TSK-4`. Task
statuses are `Planned`, `Active`, `Blocked`, `Done`, and `Canceled`; experiment statuses are `Running`, `Accepted`,
`Rejected`, and `Inconclusive`. Summaries and agent instructions contain one logical line of text; YAML folding may wrap
their source representation across physical lines.

Experiment protocols also use frontmatter with `environment`. Creation supplies `status: Running` and the record title,
checks the six protocol sections, and adds empty evidence sections. Citation and release files retain their YAML schemas
described below.

Commit accepted experiments with their exact tested implementation; that commit identifies the candidate. For a
candidate not retained in source, link its applicable patch and baseline in the record. Do not add a self-referential
commit hash or duplicate a patch when the record's commit contains the tested candidate.

Task Progress includes inline steps and linked child tasks. `workbench sync` derives a linked child’s checkbox and
status from its record; Done and Canceled children are checked, with their distinct status displayed. Ordinary steps are
manually updated. Validation rejects stale child statuses and Done tasks with unchecked steps. Completing the checklist
does not automatically complete the parent.

The task map includes unfinished tasks; other maps retain every record. Humans review new or changed ADRs before commit;
the commit accepts the reviewed text. Experiment review follows the experiment ADR. Staging selects files for a commit;
it neither establishes nor proves human approval. Agents may implement and test drafts during review. Generated
`AGENTS.md` needs no separate approval.

Reference scoped task IDs in relevant commit messages, for example `Task: app:TSK-4` in the body. A task's evidence may
cite existing commit hashes; no task must reference the hash of the commit that completes it.

Record filenames pad base-36 IDs to an even number of digits. Larger IDs use all preceding digit pairs as directories:
`app:ADR-0` resolves to `workbench/decisions/ADR-00.md`, and `app:ADR-100` to `workbench/decisions/01/ADR-0100.md`
within that scope. Titles retain the unpadded ID. `workbench/record-sequences.toml` reserves future IDs and must be
committed with records. Sync advances it for manually authored records; IDs are never recycled. A failed allocation may
leave a gap. An allocation lock prevents simultaneous writers; after a crashed process, remove its empty
`workbench/.record-allocation.lock` directory only after confirming no allocator is running. The Git gate rejects
deletion or relocation of committed record files; change their status or supersede them instead.

After publishing immutable artifacts, `workbench release add SPECIFICATION_PATH` computes their sizes and SHA-256
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

The shared [filesystem policy](../../workbench/decisions/ADR-0I.md) selects native locations for Linux, macOS, and
Windows. Linux uses XDG; macOS uses application-specific Library directories; Windows uses Known Folders, with local
storage by default and roaming storage only by deliberate choice. Feedback defaults to
`$XDG_DATA_HOME/workbench/feedback` on Linux, falling back to `~/.local/share/workbench/feedback` for unset, empty, or
relative XDG values. On macOS it uses `~/Library/Application Support/workbench/feedback`; on Windows it uses
`%LOCALAPPDATA%/workbench/data/feedback`. `WORKBENCH_DATA_HOME` explicitly overrides the Workbench data directory on
every platform and must be absolute; feedback then lives in its `feedback` subdirectory. Existing data is never moved
automatically.

Project records stay under `workbench/`, and acquired PDFs stay in the configured project library. User tool
installations and caches follow the platform locations documented below; records remain project-owned. Hosted native
verification covers Linux x64/ARM64, macOS ARM64, and Windows x64.

Citation records are one-item CSL YAML bibliographies. Their main purpose is to retain enough metadata and source URLs
for a user to acquire papers that the project does not redistribute. Import metadata from an arXiv ID or DOI, fetch an
explicit direct source, or import a PDF obtained through a human browser flow:

```sh
workbench citation add 1706.03762
workbench citation fetch workbench:CIT-0
workbench citation fetch --all
workbench citation import workbench:CIT-1 ~/Downloads/paper.pdf --source published
```

The first command performs network access for metadata. Fetch never bypasses authentication or CAPTCHA challenges.
Downloaded PDFs use source-specific deterministic names under the ignored `library/citations/` directory. A citation may
retain both published and arXiv sources. Each source has `status: pending`, `acquired`, or `unavailable`; an acquired
source also has its SHA-256, computed on fetch or import. Mark a confirmed unavailable source explicitly; a failed
automatic download does not establish unavailability. Explicit import or fetch can acquire a previously unavailable
source. `workbench update` migrates older records, including the former all-zero digest marker. The generated citation
map indexes bibliographic records rather than local files.

Citation metadata acquisition is limited to 1 MiB, PDFs to 256 MiB, and each HTTPS redirect/download chain to five
minutes. Failed or incomplete metadata is rejected; use `citation draft` to supply missing bibliographic information.

## Curated source maps

A source map explains where implementation responsibilities live. Use a short index linking subsystem maps when a single
document becomes difficult to navigate. Directory entries are sufficient where finer detail adds little value.

Configure `source_map`, `source_paths`, and optional `source_excludes` in a `[[documentation]]` table in
`workbench/automation.toml`. Workbench validation checks entries against the selected source roots, reports uncovered or
missing paths and exact duplicate entries, and follows links to subsystem maps. Exclusions apply to a path and its
contents; overlapping directory and file entries are allowed. Standard generated directories such as `node_modules`,
`build`, `target`, and `coverage` are ignored.

Start a bullet or the first table cell with a code-formatted project-relative path. Multiple leading paths may share a
responsibility. Start a bullet with a Markdown link to another map, relative to the containing map. Paths mentioned only
within explanatory prose are not entries. Source code remains authoritative; review the explanations when
responsibilities change. Counts and exhaustive per-file descriptions are unnecessary.
