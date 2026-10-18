---
summary: Authorization, helpers, plugins, caller-owned paths.
---

# ADR-J: Trust and privilege boundaries

Declare trusted inputs, callers, and executable code at each privilege boundary. Authenticate and authorize before
effects; privileged helpers perform narrow operations while caller-owned code remains unprivileged. Validate ownership
when using caller-supplied paths or transferring artifacts.

System launcher installation uses administrator authority only to publish owned executable files. Project acquisition,
configuration, and checks run as the invoking user; installation never evaluates project code with elevated authority.

In-process native plugins share the host's trust and privileges. Isolate untrusted extensions outside that process; an
ABI or module boundary is not a sandbox.

Rationale: Explicit authority prevents convenient integration boundaries from being mistaken for security isolation.
