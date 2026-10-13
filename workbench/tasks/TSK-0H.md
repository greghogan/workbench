---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-H: Reorganize and shorten draft ADRs after the comprehensive review

## Review summary

Apply the human-approved organization recommendations from workbench:TSK-F to the unaccepted draft ADRs: place
collections among shared foundations, group language policies, and shorten procedural passages. Preserve the policies,
historical evidence, and optional benchd collection. Record approval of the consumer portability and cache follow-ups
and the renewed draft-branch CI authorization. The complete root CI gate passed 343 tests and coverage floors; document
ordering and references pass validation. ADR acceptance remains pending.

## Context

The human requested these draft updates on 2026-10-11 and made the GitHub repository public. Temporary hosted
verification may use `ci/draft-functionality-20261008` or a similarly named branch before ADR review is finished. This
does not accept the documents or authorize deployment. Packaging changes and collection-selection preflight were
requested for explanation and remain proposals.

## Progress

- [x] Renumber the six drafts together and update current references without rewriting historical evidence.
- [x] Shorten shared policy and newer language ADRs; retain procedural detail in guides.
- [x] Record approved consumer portability/cache follow-ups and draft-branch verification scope.
- [x] Synchronize context and validate ordering, references, formatting, and optional collection behavior.
- [x] Record the final mapping and verification evidence for human review.

## Outcome

Shared collections move from ADR-18 to ADR-L. Java, JavaScript, Ruby, and PHP become ADR-17 through ADR-1A; AWS moves to
ADR-1B. Existing language IDs ADR-11 through ADR-16 and benchd:ADR-0 retain their identities. The next-ID allocator
remains monotonic; this authorized reordering of unaccepted drafts does not introduce an automatic renumbering feature.

No review receipt, charter, immutable collection export, dependency/environment pin, or staged content is changed. No
commit or push is part of this documentation pass. Workbench:TSK-G owns implementation portability; workbench:TSK-7 owns
cache improvements and hosted verification.

## Verification

The full native root CI-stage gate passed 343 tests in 64 files, including the revised optional-collection regression.
Coverage floors, formatting, lint, types, bundle parity/licenses, structural checks, shell checks, actionlint,
executable README documentation, locked dependency advisories, and credential checks passed. Final task/map
synchronization and document validation passed afterward. See
[the mapping and verification evidence](../evidence/adr-review-20261011.json). The five longer shared ADRs are
approximately 31% shorter in total; procedural requirements remain in guides and executable checks. Other native
platforms and the hosted matrix were not run for these documentation changes.
