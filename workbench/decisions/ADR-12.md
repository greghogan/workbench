---
summary: Supported interpreters and strict tools.
---

# ADR-12: Python implementation

Apply ADR-9. `.python-version` or the selected environment owns the exact development interpreter; `requires-python`
declares supported interpreters.

Use the [CPython support table](https://devguide.python.org/versions/) to select maintained minor release lines; both
bugfix and security-only maintenance count as maintained. Select project compatibility profiles from those supported
minor lines under ADR-9.

Type and validate public data boundaries.

The reference uses uv, Ruff formatting and all stable lint rules with documented exclusions, strict mypy, and pytest
with coverage and advisory duration reporting; equivalent tools are allowed.

Rationale: Validated boundaries and repeatable checks preserve Python flexibility while making mistakes observable
early.
