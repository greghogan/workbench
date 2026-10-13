---
summary: Metadata, migrations, formatting, validation.
---

# ADR-4: Record schemas and canonical formatting

Decisions, tasks, experiments, and environments use Markdown with YAML frontmatter for structured metadata. Citations
retain CSL-compatible YAML; releases retain structured YAML. Each type defines its required fields and relationships.
Project-specific metadata belongs in an explicit extensions mapping.

One workspace schema version in the root configuration covers project configuration and records in all registered
scopes. Individual records do not repeat it. Updates migrate the workspace to the selected distribution's schema;
ordinary commands require that current schema. The dependency revision identifies the software, while the workspace
version identifies applied data migrations. Older formats are handled only by explicit migrations.

Records share a deterministic formatting workflow. Formatting preserves values, comments, deliberate line breaks, and
embedded evidence while normalizing document layout and reflowing prose toward the configured width. A second formatting
pass produces no change. Unbreakable content and evidence may exceed the width target.

Formatting works on incomplete drafts. Validation separately checks schemas, references, required content, and canonical
formatting. It reports problems without changing files. Record creation formats its output; direct file editing remains
supported through the same formatting and validation rules.

Batch formatting covers records in registered project scopes. Charters remain human-written; generated maps and agent
context are checked against their sources. Format records before human review; formatting does not replace the review
required for ADRs and experiments.

Rationale: Standard syntax avoids a custom document language. Shared formatting removes discretionary layout changes
from review, while separate semantic validation supports incremental drafting and protects record meaning.
