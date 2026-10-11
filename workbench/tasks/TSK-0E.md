---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-E: Add Ruby and PHP language support

## Review summary

Implement Ruby, then PHP, with independent examples, reusable language definitions, verified native acquisition, managed
environments, compatibility matrices, strict checks, coverage, and relocated release verification. Perl is excluded at
the human's request. Draft language decisions remain subject to human review; no push is authorized.

## Progress

- [x] Implement and verify Ruby acquisition, example, configuration, and baseline.
- [x] Implement and verify PHP acquisition, example, configuration, and baseline.
- [x] Integrate compatibility, managed environments, caches, and releases for both languages.
- [x] Add refresh skills, draft decisions, documentation, and regression evidence.
- [x] Review the changes and record local verification and remaining hosted coverage.

## Plan

Use Ruby 4.0 with a Ruby 3.3 baseline and PHP 8.5 with a PHP 8.2 baseline. Pin current patches of every maintained
release line. Keep language-native manifests and locks authoritative, dependency installations outside the checkout, and
check tools package-managed. Retain existing Nix and Guix revisions for the new environments.

Prove source and artifact verification, failed-install cleanup, baseline rejection, supported release behavior, coverage
floors and change presentation, and release use outside the source checkout. Exercise all configured Linux x64 targets
locally; retain other-platform and hosted publication verification in workbench:TSK-7.

## Outcome and verification

Ruby and PHP now have independent references and reusable definitions, maintained compatibility matrices, verified
runtime and package-manager acquisition, external dependency caches, strict lint and type checks, coverage, managed
environments, and relocated releases. Perl was not added.

All 13 added Linux x64 targets passed: native gates and releases, every maintained compatibility version, Guix, Nix
Docker and Dev Containers. The final Workbench gate passed 334 tests, coverage floors, formatting, lint, types, bundle
parity, workflow and shell validation, documentation examples, advisory checks and credential scanning. Ruby reached
100% line and branch coverage; PHP reached 100% line, branch and function coverage. Negative probes rejected missing and
mismatched Ruby lock hashes; PHP's suite verifies fail-closed archive validation and explicit checksum recording. Actual
Windows RubyInstaller archives passed hashes and signatures, and the latest passed bounded extraction locally; their
executables were not run.

Verification corrected source SDK cache identity, Bundler extension isolation across native and container userspaces,
PECL gzip decoding, early Xdebug filtering, and current PHPUnit coverage serialization. Cache plans and both refresh
skills also passed validation. See [verification evidence](../evidence/languages-ruby-php-20261011.json).

Hosted and other-platform execution remains workbench:TSK-7. Draft workbench:ADR-19 and workbench:ADR-1A await human
review. No commit, push, publication or ADR acceptance occurred.
