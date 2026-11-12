# Record collections

- `src/core/collections/policy-receipts.ts`: Preserve bounded compatibility acknowledgments for independently reviewed
  policy digests.
- `src/core/collections/collections.ts`: Verifies collection inventories and resolves editable project collections and
  independent local guidance.
- `src/core/collections/collection-git.ts`: Fetches and verifies source commits without checkouts, reads original blobs,
  and manages submodule metadata and explicit gitlink staging.
- `src/core/collections/collection-schema.ts`: Validates collection identities, pins, manifests, and local lookup
  directories.
- `src/core/collections/collection-install.ts`: Prepares local policy drafts or adopts a self-contained collection into
  the project.
- `src/core/collections/collection-reconcile.ts`: Compares adaptations and prepares three-way reconciliation with
  conflict proposals.
- `src/cli/collections.ts`: Exposes inspection, adoption, updates, export, comparison, and audience checks.
- `src/core/collections/collection-maps.ts`: Generates maps from authoritative record titles and summaries.
- `src/core/collections/collection-files.ts`: Reads bounded collection files and shares three-way reconciliation
  primitives.
- `src/core/collections/local-policy.ts`: Keeps local originals, editable drafts, exact human activation approvals, and
  removals.
- `src/core/collections/local-context.ts`: Generates installation-owned local contexts and the portable user discovery
  entry point.
- `src/core/collections/policy-compatibility.ts`: Fingerprints active local and project policy, acknowledges reviews,
  and checks freshness.
- `src/cli/local-policy.ts`: Exposes local activation and per-checkout compatibility review commands.
- `src/core/collections/collection-provision.ts`: Freezes optional local guidance into disposable CI workspaces.
- `src/core/records/record-resolver.ts`: Resolves project-owned and local ADR references.
- `src/core/collections/collection-service.ts`: Own collection exports, comparisons, audience checks, and
  post-application synchronization and validation shared by CLI and web workflows.
- `src/core/collections/initial-collection.ts`: Select the initial committed Workbench collection and share exact import
  acceptance and terminal confirmation across collection adoption interfaces.

- `src/core/collections`: Acquires and reconciles adopted records and maintains independently approved local policy.

- `src/core/review`: Binds human and agent acknowledgments to presented contents and enforces required review evidence.
