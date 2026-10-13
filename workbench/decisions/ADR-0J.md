---
summary: Authorization, helpers, plugins, caller-owned paths.
---

# ADR-J: Trust and privilege boundaries

Declare trusted inputs, callers, and executable code at each privilege boundary. Authenticate and authorize before
effects; privileged helpers perform narrow operations while caller-owned code remains unprivileged. Validate ownership
when using caller-supplied paths or transferring artifacts.

For shared installations under ADR-2, users control only their own profiles and retention roots. Immutable system
contents and the parent ownership structure remain protected from ordinary users. System maintenance considers all
users' roots and uses administrator authority or a narrowly authorized service; it never executes project code with that
authority. Users cannot remove another owner's roots. Keep private project locations out of shared public metadata.

In-process native plugins share the host's trust and privileges. Isolate untrusted extensions outside that process; an
ABI or module boundary is not a sandbox.

Rationale: Explicit authority prevents convenient integration boundaries from being mistaken for security isolation.
