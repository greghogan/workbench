---
summary: One application release, independent collection adoption, runtime authority, and deliberate updates.
---

# ADR-0: Workbench application and distribution

The CLI, browser service, and shared TypeScript application services form one Workbench application and installed
release. Shared services own project, record, review, and execution rules; additional interfaces do not create another
authority. Repository build and test tooling verifies this product as a whole.

Workbench is distributed as JavaScript for Node.js. Releases include discoverable source, tests, and examples with an
immutable source identity available after installation. Copied starters remain independently usable. Launching an
already acquired revision with its required runtime available needs no connectivity or redundant acquisition.

Startup support and command-runtime requirements are declared independently. Bootstrap preserves system runtimes, shell
defaults, and consuming-project toolchains, reusing compatible installed runtimes. Additional acquisition requirements
are explicit. Managed environments retain authority over the command runtime.

Offer user installation without administrator access and system installation with the required authority. Explain how to
make the installed command available.

New projects adopt the initial shared Workbench collection unless explicitly declined, with one confirmation available
for the exact imported set. Existing projects retain their policy and collection choices. Collection ownership and
subsequent review follow workbench:ADR-3 and workbench:ADR-L.

Application and collection updates are independent. Installing or updating the application preserves project policy.
Projects adopt and reconcile collections from independently selected immutable Git revisions, preserving local
adaptations.

Rationale: A coherent application release keeps interfaces and shared rules consistent. Independent application and
collection updates preserve project policy ownership while allowing deliberate tool maintenance.
