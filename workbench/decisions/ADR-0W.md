---
summary: Keyboard access, plain presentation, independent color control, safe rendering, cancellation, and restoration.
---

# ADR-W: Terminal user interfaces

Terminal interactions have repeatably verifiable behavior, and visible help agrees with the available controls.

Keep automatable operations available through explicit noninteractive commands. Support complete keyboard operation and
convey meaning independently of color.

Workbench's terminal interface honors `NO_COLOR` independently of its plain presentation preference. Users can select
plain presentation through a command-line option, an environment variable, or a saved user preference, with precedence
in that order. Plain presentation provides stable text, complete labels, and line-oriented interaction without color,
animation, or screen redraws. Presentation choices preserve command behavior and human approval requirements.

Render external text as content without interpreting embedded terminal controls. Restore terminal state on normal exits,
handled failures, and catchable interruptions. Verify interaction behavior and terminal restoration.

Rationale: Verifiable interaction and accurate help make terminal controls dependable. Keyboard access and
noninteractive commands keep operations available across users and automation; safe rendering and terminal restoration
protect the surrounding session.
