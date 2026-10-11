---
summary: Streaming acquisition, signatures, bounded extraction, language filters, local activation and caches.
---

# ADR-O: Native artifact acquisition and installation

Apply ADR-9 and ADR-K to runtime, tool, and bootstrap downloads: verify recorded digests and available upstream proofs,
declare trust identities and absent authentication, and never fall back after verification failure. Acquire private ABI
dependencies through the same boundary while preserving host SDK and system-library selection.

Delegate package-managed acquisition, integrity checks, resolution, and extraction to the package manager using
committed locks. Local and CI setup share verified installers; reject unlocked fallbacks. Project bootstrap definitions
use ADR-1's complete replacement mode.

Prefer suitable upstream Zstandard archives. Filter while decompressing the HTTP stream using language-owned inclusion
rules, retaining required components and dependencies. Independent examples remain independently runnable. Revalidate
filters and required contents whenever the immutable source pin or filter revision changes.

Extract privately on the installation filesystem. Before filesystem effects, validate paths, entry types, duplicate
names, and links; prevent writes through links and retain only contained, resolvable targets. Independently bound
compressed/decompressed bytes, retained bytes, individual entries, metadata, entry count, decompressor memory, and
elapsed time. Filtering does not prevent resource exhaustion; staging does not sandbox archive parsers.

Hash incoming and retained contents while streaming. A manifest binds retained paths, permissions, and link targets;
hash compressed cache output as written. Authentication, extraction, and component validation precede execution or
activation. Activate by atomic rename to the local installation path. Failure or cancellation removes owned staging data
and preserves existing installations.

Package definitions declare executable probes and version rules shared by installation and environment checks; never
infer executable names from package names. Verify usability separately from authenticity, selecting only the package and
its dependencies. Library-only packages use content validation.

Cache verified installations in platform user-cache storage. Identities cover source digest, platform, architecture,
language, filter, authentication policy, trust material, and resource bounds. Preserve integrity manifests and
provenance through cache packing; verify contents on restore. Cache digests detect corruption without replacing upstream
authentication. Ordinary checks do not reacquire missing tools. Project cleanup preserves shared toolchains; durable
records stay separate. Keep limits, package layouts, and maintenance recipes in configuration and user documentation.

Rationale: Streaming selection reduces storage while explicit authentication and resource boundaries preserve the trust
required to install executable tools.
