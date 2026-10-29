---
status: Approved
parent: demo:TSK-8
depends_on:
  - demo:TSK-6
---

# TSK-B: Centralize note identity normalization

## Review summary

The [index review](TSK-08.md) found that import and lookup paths need the same interpretation of a note's identity.
Consolidate those rules after the [parsing boundary](TSK-06.md) is available, preserving existing references and the
reader's filenames.

This second selected refactor shows how a review can aggregate coherent work while its children retain separate plans,
verification, and dependency order. The example starts Approved and queued, waiting for its prerequisite.

## Implementation details

- [ ] Identify the existing identity rules at import and lookup boundaries.
- [ ] Give those callers one normalization contract.
- [ ] Exercise Unicode filenames, relative references, and missing-note errors.

## Validation

Check that the same source note resolves to the same identity through each caller. Preserve ordinary file names and
existing reference behavior. This fictional task has no implementation or test result yet.
