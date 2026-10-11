---
summary: Supported interpreters and strict tools.
---

# ADR-12: Python implementation

Apply ADR-9. `.python-version` or the selected environment owns the exact development interpreter; `requires-python`
declares supported interpreters.

Use the [CPython support table](https://devguide.python.org/versions/) to select maintained minor release lines; both
bugfix and security-only maintenance count as maintained. Apply ADR-9's release-line coverage to supported CPython minor
lines.

Type and validate public data boundaries.

The reference uses uv, Ruff formatting and all stable lint rules with documented exclusions, strict mypy, and pytest
with coverage and advisory duration reporting; equivalent tools are allowed.

Rationale: Validated boundaries and repeatable checks preserve Python flexibility while making mistakes observable
early.
