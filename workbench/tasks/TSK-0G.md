---
status: Done
parent: null
depends_on: []
---

# TSK-G: Make shared language automation portable to consuming projects

## Review summary

Make reusable language commands and compatibility testing honor consuming-project definitions. The comprehensive review
found sample artifact names embedded in shared adapters and fixed test runners in compatibility execution. Ordinary
local replacement works, but currently does not replace those runtime adapters. The human approved this follow-up on
2026-10-11. Make compatibility commands part of the selected complete language definition, and separate reusable tool
setup from project-owned build and release contracts. Hosted verification follows under workbench:TSK-7.

## Context

See the [project review](../evidence/project-review-20261011.md). Shared release verification now invokes an explicit
project-owned `release-verify` check, but the remaining reference assumptions still need attention.

## Progress

- [x] Define how language definitions select compatibility setup and test commands for a selected runtime.
- [x] Remove sample artifact names from reusable build/release adapters, or move those adapters into copied examples.
- [x] Keep sample behavioral assertions in project-owned verification commands.
- [x] Prove ordinary checks, compatibility, and releases with consumers using different package names and test runners.
- [x] Document starter versus complete environment adoption and verify standalone copying.

## Acceptance

A consuming project can retain shared record policy and replace its complete language definition without editing the
pinned Workbench distribution. Its CI executes its own declared test and release contracts. Existing examples preserve
their strict checks and supported-version matrices.

## Validation

The complete Linux x64 rehearsal passed all 76 targets with no infrastructure errors. The root CI gate passed 357 tests,
coverage floors, lint, type checks, bundle parity, workflow checks, documentation examples, and dependency advisories.
Both owned Rust Miri modes passed. See [portability evidence](../evidence/consumer-automation-20261011.json).
