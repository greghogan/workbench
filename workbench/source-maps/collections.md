# Shared collections

Resolve locally installed and project-pinned standards without copying ownership.

| Paths                         | Responsibility                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/collections.ts`          | verifies installed collection inventories, resolves shared pins and automatic local registries, and installs immutable revisions from explicitly acquired local sources. |
| `src/collection-schema.ts`    | validates collection identities, pins, manifests, and machine-local lookup directories.                                                                                  |
| `src/collection-install.ts`   | preflights proposed policy selections and atomically selects related installations.                                                                                      |
| `src/collection-commands.ts`  | exposes collection inspection, installation, selected ADR exports, policy comparisons, and audience checks.                                                              |
| `src/collection-links.ts`     | resolves portable shared source links without importing machine-local context.                                                                                           |
| `src/collection-maps.ts`      | renders exported decision maps from verified record metadata.                                                                                                            |
| `src/collection-provision.ts` | freezes verified local collection files and selections into disposable CI workspaces.                                                                                    |
| `src/record-resolver.ts`      | resolves integrated ADR references while keeping other records project-owned.                                                                                            |
| `collections`                 | owns shipped provider exports and the distribution's explicit collection dependency pins.                                                                                |
