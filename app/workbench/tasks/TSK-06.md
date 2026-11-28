---
status: Accepted
added_at: 2026-11-19T15:30:44.770Z
---

# TSK-6: Sign unpublished commits

## Review summary

When Git's `commit.gpgSign` is enabled, Workbench attempts to sign new local commits through Git's configured signer.
Unsigned local commits can still be created and finalized. Projects can set `review.signed_commits` to require
verifiable signatures before publication. That requirement defaults to false.

Run `workbench sign` in the developer's terminal to sign the configured author's unsigned unpublished commits on the
current branch, including commits brought in by a merge. A branch or tag argument can select unpublished work outside
the current branch.

When unsigned commits block a push, the hook points to `workbench sign`. After signing, run `git push` as usual. Signing
changes commit IDs, so the push needs to start with the newly signed history.

### Interrupted history rewrites

Signing and finalization resume an interrupted rewrite at the next relevant Workbench operation. A repository using
file-based refs can retain some old and some new branch or tag pointers after interruption. Workbench finishes the
prepared rewrite when every affected ref still points to one of its expected versions and the rewrite remains safe. If a
ref has moved elsewhere, Workbench names it and preserves both histories. Recovery reuses prepared signatures.

Both Git ref formats support signing, finalization, and live updates to plan and review views. When the CLI detects a
partially applied batch on file-based refs, it reports the recovery outcome and points to optional reftable migration
for atomic updates to shared branches and tags.

### Delivery checklist

- [x] Sign unpublished history and enforce the optional publication signature policy.
- [x] Recover interrupted signing and finalization automatically, with format-specific advice when relevant.
- [x] Refresh ref-dependent views on both Git ref formats.

## Implementation account

Signing is limited to commits whose author name and email match the configured Git author. Other authors' commits retain
their authorship and signing status. Workbench preserves existing signing keys or leaves the live refs in place when the
original signer cannot be used.

Signing and finalization preserve the author and committer dates of the commits they replace. Git's signer supplies any
signature creation time.

Git’s signer retains terminal access. A failed signer leaves a newly created local commit unsigned, and background
finalization can finish unsigned history. The optional publication check distinguishes unsigned commits from invalid or
untrusted signatures using the history available at the receiving repository.

Recovery uses the original checkout to recheck review and publication constraints. It verifies already updated refs and
conditionally updates the remaining ones in one Git transaction. Canceling or failing during signature preparation
leaves no recovery refs. Live views observe the ref storage Git uses for both the shared repository and the selected
checkout.

Maintained tests verify signing after rebase, amend, and cherry-pick with both SSH and OpenPGP, and check the outgoing
signatures against a local receiver. A Linux terminal test uses a passphrase-protected SSH key to verify successful
signing and preservation of the original history on cancellation, signer failure, or a branch created at the prompt.

## Implementing-agent detail

- Identify unpublished commits from known remote history across the repository. Keep the signing command local. Stop if
  an affected reference may already be published and explain what to check or fetch.
- Reuse the history rewrite and recovery rules. Preserve messages, authorship, source trees, parent order, staged and
  working files, and applicable review evidence. Prepare and verify the signatures before moving affected local
  references together. Preserve published history and other contributors’ signatures. If recreating a commit or tag
  would replace another contributor’s signature, identify it and stop.
- Keep the terminal available when the developer runs `workbench sign`. Cancellation, signer failure, or a changed
  reference detected before activation prevents the rewrite. Leave passphrases and caching to Git’s signing tools.
- Make the publication check opt-in and disabled by default. Verify Git’s actual outgoing commits, including merge sides
  and commits introduced through tags. Report missing signatures separately from invalid or untrusted ones.
- Persist the exact ref moves and protect the old and prepared objects before either rewrite activates. Share recovery
  between signing and finalization. Recheck publication, checkout, and review constraints before moving refs. Verify
  already-moved refs and conditionally update the remaining ones in the same Git transaction. If every ref moved, finish
  any pending Workbench state updates. Preserve unexpected ref values, including a deleted ref.
- Read and write refs through Git. Observe changes to the repository's shared and checkout-specific ref storage so
  external Git operations refresh affected live views. Offer migration advice only on a detected partial multi-ref
  update with the `files` backend. Keep migration a separate manual action and document its worktree and tooling
  requirements.

### Verification

- Start with unsigned work on a branch with a merge and commits from more than one author. Sign the branch in one
  invocation and verify its published ancestors, authorship, source trees, and review evidence stay intact. Exercise a
  tag that introduces additional unpublished commits.
- Exercise a real signing prompt, cancellation, signing failure, a reference moving during signing, and an existing
  signature by another contributor. Verify the original history remains selected if the rewrite cannot finish safely.
- Finalize unsigned reviewed work. Enable publication enforcement, verify that an ordinary push reports unsigned or
  unverifiable commits, then sign and push again. Confirm that the receiving repository has the expected signatures.
- Run signing and finalization with branches and tags on both ref formats, including a linked checkout. Interrupt before
  activation, after a subset of refs has moved on `files`, and after Git finished before Workbench recorded completion.
  Verify automatic recovery is repeatable, preserves checkout contents and prepared signatures, and reports intervening
  ref changes without overwriting them. Verify the CLI migration advice appears only for the partial update.
- Check that external ref creation, update, and deletion refresh plans and record reviews on both formats, including
  shared branch changes from a linked checkout.
