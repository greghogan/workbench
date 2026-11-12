---
summary: Concise workflows, policy boundaries, consistent invocation, skill ownership, and behavioral evaluation.
---

# ADR-6: Skills and policy boundaries

Skills own selected workflows and non-obvious mechanics; ADRs own policy. Keep skills concise and avoid repeating
policy. Disabling a skill does not waive an applicable policy requirement. Discovery makes a skill available, not
scheduled. Descriptions define applicability and invocation criteria, and skills verify their target scope. Invocation
policies remain consistent across supported harnesses.

Skill discovery preserves independently authored skills. Naming collisions require explicit resolution.

Verify actual instruction and skill discovery in isolated, explicitly selected tests without retained conversation
history. Evaluate substantial workflow changes through realistic disposable projects, checking behavior, scope, and
advice quality. Keep model-dependent evaluations separate from deterministic gates and record the model, skill revision,
outcomes, and limitations.

Rationale: Separate policy and workflow authority keeps requirements independent of skill selection. Concise
instructions, consistent invocation, and behavioral evaluation support dependable use across harnesses while preserving
independently authored work.
