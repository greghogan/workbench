---
summary: Shared plan approval, local execution queues, source-bound evidence, and recoverable transitions.
---

# ADR-7: Task workflow and local queue

Human plan approval and outcome acceptance follow workbench:ADR-7. Queue selection and ordering are personal execution
choices; neither grants approval. Protected-document acknowledgment remains a separate decision under ADR-6.

Task workflow views distinguish plans awaiting human approval, approved work and its execution progress, and outcomes
awaiting human acceptance. Keep record browsing separate from this workflow.

Local execution queues retain order, active work, and progress. Keep that state separate from tracked task records and
human decisions, preserving it across cache cleanup and service restarts. CLI and browser operations use the same queue,
readiness rules, and human decisions. Queue operations coordinate work without launching agents or creating commits.

A queued task is ready only when its plan is approved and its prerequisites are satisfied. Implementation evidence
applies to the plan and source version actually verified. It establishes implementation at that version, without
verifying later edits or granting human acceptance.

Plan approval applies to the approved plan version, independently of the executing agent or checkout. Delegated agents
may use that approval within its authorized scope. Execution assignments and progress remain separate from human
approval and acceptance.

Reject stale task and queue updates and conflicting starts of the same queued task. Recovery restores consistency
between task records, human decisions, and local queue progress without overwriting intervening user edits or newer
human decisions.

Rationale: Persistent local coordination supports work across sessions without turning execution bookkeeping into shared
project history. Distinct human decisions and version-bound evidence prevent queue activity from implying approval or
acceptance.
