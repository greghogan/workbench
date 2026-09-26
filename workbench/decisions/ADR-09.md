# ADR-9: Opt-in backward compatibility

Summary: Backward compatibility is disabled by default and enabled only through human-controlled project configuration.

Agent instruction: Do not preserve backward compatibility unless `compatibility.required` is true; humans set it.

The root configuration contains:

```toml
[compatibility]
required = false
```

Only a human changes this value. When false, migrate project-owned callers and data with the design; do not add
speculative shims. When true, identify and test the public or persisted contracts in scope.
