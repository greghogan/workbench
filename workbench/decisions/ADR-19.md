---
summary: Stable resource identities, direct navigation, hypermedia controls, and explicit view choices.
---

# ADR-19: Web interfaces and stable URLs

Web resources have canonical URLs independent of storage, implementation, and display names. Published link contracts
follow ADR-D.

Direct navigation, bookmarks, reloads, and browser history work without prior navigation. Web interfaces are
hypermedia-driven.

An unversioned URL identifies the current resource. Versioned URLs, when offered, identify a retained version.

Saved and shared URLs preserve explicitly selected filters and presentation choices, including choices matching current
defaults. Omitted choices follow the declared defaults.

Temporary links identify themselves. Expired links explain their status and provide a path to current information.

Rationale: Stable URLs make resources shareable. Hypermedia keeps clients independent of endpoint structure, while
explicit choices preserve the meaning of saved links.
