# Record collections

Retain upstream Git objects, edit authoritative project copies, and reconcile updates.

| Paths                          | Responsibility                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/collections.ts`           | Verifies collection inventories and resolves editable project collections and independent local guidance.                                 |
| `src/collection-git.ts`        | Fetches and verifies source commits without checkouts, reads original blobs, and manages submodule metadata and explicit gitlink staging. |
| `src/collection-schema.ts`     | Validates collection identities, pins, manifests, and local lookup directories.                                                           |
| `src/collection-install.ts`    | Prepares local policy drafts or adopts a self-contained collection into the project.                                                      |
| `src/collection-reconcile.ts`  | Compares adaptations and prepares three-way reconciliation with conflict proposals.                                                       |
| `src/collection-commands.ts`   | Exposes inspection, adoption, updates, export, comparison, and audience checks.                                                           |
| `src/collection-maps.ts`       | Generates maps from authoritative record titles and summaries.                                                                            |
| `src/collection-files.ts`      | Reads bounded collection files and shares three-way reconciliation primitives.                                                            |
| `src/local-policy.ts`          | Keeps local originals, editable drafts, exact human activation approvals, and removals.                                                   |
| `src/local-context.ts`         | Generates installation-owned local contexts and the portable user discovery entry point.                                                  |
| `src/policy-compatibility.ts`  | Fingerprints active local and project policy, acknowledges reviews, and checks freshness.                                                 |
| `src/local-policy-commands.ts` | Exposes local activation and per-checkout compatibility review commands.                                                                  |
| `src/collection-provision.ts`  | Freezes optional local guidance into disposable CI workspaces.                                                                            |
| `src/record-resolver.ts`       | Resolves project-owned and local ADR references.                                                                                          |

Collection integration scenarios are independently scheduled in `tests/collection_adoption.test.mts`,
`tests/collection_reconciliation.test.mts`, `tests/collection_conflicts.test.mts`, `tests/collection_recovery.test.mts`,
and `tests/collection_exports.test.mts`. `tests/fixtures/collection-scenarios.mts` owns their per-file fixture cleanup
and shared collection operations.
