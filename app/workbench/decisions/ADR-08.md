---
summary: Original and readable document views, local availability, explicit acquisition, and isolated content.
---

# ADR-8: Acquired document presentation

Offer acquired originals and readable copies when available, with explicit downloads of their stored bytes. Show current
local availability.

Reading and navigation do not acquire missing documents. Retain a link to the original source.

Treat acquired documents as untrusted. Readable views preserve meaningful source structure and embedded illustrations
while excluding active content and unrelated site interface. Original views remain isolated from application authority.
Automatic external content requests are blocked by default; a user may explicitly permit remote images for that view.
Ordinary external links remain available through deliberate navigation.

Rationale: Original and readable views make preserved material useful and inspectable. Explicit acquisition and isolated
rendering preserve local availability, source evidence, and user control over external access.
