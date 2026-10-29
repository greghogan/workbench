---
summary: Independent human choices for backward compatibility and migration or deletion of existing data.
agent_instruction:
  Only humans change `compatibility.required` and `compatibility.data`; when compatibility is disabled, update
  project-owned callers without shims. Follow the selected data policy or explicit user instructions.
---

# ADR-D: Compatibility and existing data

`compatibility.required` defaults to false in root configuration. When false, update project-owned callers with the
design instead of adding speculative shims. When true, identify and test the public or persisted contracts in scope.

`compatibility.data` independently selects handling of existing data made incompatible by a requested change: `ask`
(default) obtains the user's direction; `migrate` preserves the data through migration; `delete` discards it instead of
implementing migration, even when it cannot be regenerated. Configured deletion supplies standing authorization only for
the affected data. Explicit user instructions for a change take precedence over this policy.

Only humans change either setting. Disabling backward compatibility alone does not authorize discarding data or active
work. Keep configuration procedures in the adoption guide.

Rationale: Independent human choices avoid speculative compatibility support and unwanted migrations or data loss.
