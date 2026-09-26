# ADR-0: Accepted Decision Record

Summary: Accepted Decision Records become binding when a human-reviewed commit contains them.

Agent instruction: Charters are human-written; humans approve changed Accepted Decision Records before commit.

An Accepted Decision Record (ADR) captures a durable choice and its rationale. Shared Workbench ADRs govern consuming
projects; project ADRs govern their subprojects. A narrower ADR may refine an inherited decision by naming it and the
replacement rule.

Every ADR has a title and routing `Summary`. Use `Agent instruction` only for a standing rule an agent would not find
from the title and summary; Workbench copies it into the root `AGENTS.md`.

A commit containing an ADR is its acceptance. Agents may implement and test a proposed decision before that commit.
Humans review the ADR before committing it. Derived `AGENTS.md` needs no separate approval.

Workbench generates the entire `AGENTS.md` from the human-written charter, decision-map routing, and mapped ADR
instructions. Sync rewrites it; validation only compares it with those sources.

An ADR that supersedes another names the affected record and replacement rule. Tasks and charters do not silently
override accepted decisions.
