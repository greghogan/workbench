---
summary: Local browser access, typed server rendering, coherent updates, and scoped navigation.
---

# ADR-5: Local browser interface

The browser interface is a local, single-user view of the same application services used by the CLI. Bind listeners to
loopback; users arrange remote access. Project files remain authoritative; shared application authority follows ADR-0.

Use TypeScript JSX and pinned Preact for server-rendered HTML. Escape ordinary text and confine raw HTML to safe
document rendering. Core navigation and forms remain usable without JavaScript; browser scripts enhance interaction.
Ship application assets locally. Accessibility follows workbench:ADR-18, and resource navigation follows
workbench:ADR-19.

Refresh record views asynchronously when files change, publishing coherent updates and retaining the last usable view
during refresh or failure. Preserve unsaved user input. Cache measurements refresh independently, without blocking
navigation or discarding the last usable size estimate. Record editing and acknowledgment follow ADR-6.

Present registered projects, subproject hierarchies, and collections as distinct sources. Names and breadcrumbs follow
registered identities rather than incidental directories. Demonstration mode identifies itself and remains isolated from
real projects. Cache maintenance follows ADR-2.

Keep the selected scope when changing between record and workflow views. Workflow views include that scope and its
descendants; the root provides a project-wide view. Counts and continuation follow the displayed selection without
changing project-wide review or publication requirements.

Rationale: Typed server rendering supports checked markup and automatic escaping. Local assets and coherent updates keep
the interface usable during refresh and without external services; preserving unsaved input protects work.
