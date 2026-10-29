---
status: Planned
---

# TSK-9: Plan portable notebook export

## Review summary

Explore an offline export that a reader can copy to another machine without an account or service. This example starts
in planning, with implementation not yet approved and the output format and overwrite behavior still open.

Keep the overview stable enough to explain the intended outcome while revising the approach as questions are answered.
Use a separate child task for the decisions that need their own investigation; do not treat their order in the task map
as permission to implement.

## Questions and confirmed constraints

- Existing constraint: notes remain authoritative ordinary files; export must preserve them.
- Open question: should the first export be a directory of notes or a portable archive?
- Open question: how should an existing destination be handled without losing the reader's files?

## Implementation details

- [ ] demo:TSK-A: Define export boundaries and acceptance criteria
- [ ] Reconcile the proposed approach with the developer's answers.
- [ ] Present a concrete plan for approval before implementation.

## Validation plan

The eventual approved plan should cover an empty notebook, Unicode filenames, unavailable destinations, and safe failure
when output already exists. These are proposed acceptance cases, not completed tests.
