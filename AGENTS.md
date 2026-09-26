# Agent context

## Charter

Build a framework for organizing documents useful for agentic software development. Under this framework, collect best
practices into a shareable module which can be referenced from any project. Continuously innovate and refine to match
increasing agent intelligence and capabilities and project diversity and scope.

AI agents accelerate software creation causing human attention to increasingly bottleneck development. Delineate
documents which must be human-written and those requiring mandatory human review from the remainder of the project where
human review is optional at the discretion of the agent.

## Decision routing

Read this project's `workbench/decision-map.md` after this file.
Open individual ADRs when relevant detail is needed; do not read every ADR by default.
Changed ADRs require human approval before commit.

## Standing instructions from decisions

- `workbench:ADR-0`:
  Charters are human-written; humans approve changed Accepted Decision Records before commit.
- `workbench:ADR-6`:
  With benchd installed, use `benchctl hold` for builds, tests, and CPU-heavy work; ask before bypass.
- `workbench:ADR-9`:
  Do not preserve backward compatibility unless `compatibility.required` is true; humans set it.
- `workbench:ADR-D`:
  Run applicable Workbench checks before completion; use `workbench checks list` to inspect roles.
- `workbench:ADR-G`:
  Do not update Guix or Nix versions or pins unless a human explicitly requests it.
