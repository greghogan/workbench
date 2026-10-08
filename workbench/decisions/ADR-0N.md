---
summary: Human-set opt-in; caller/data migrations.
agent_instruction: Humans set `compatibility.required`; when false, migrate callers and data without shims.
---

# ADR-N: Opt-in backward compatibility

The root configuration contains:

```toml
[compatibility]
required = false
```

Only a human changes this value. When false, migrate project-owned callers and data with the design; do not add
speculative shims. When true, identify and test the public or persisted contracts in scope.

Disabling compatibility does not authorize discarding user data or active work; migrate retained data explicitly.

Rationale: Compatibility adds maintenance cost; an explicit human choice prevents speculative support from accumulating.
