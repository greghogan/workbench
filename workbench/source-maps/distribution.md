# Distribution and updates

Start the pinned CLI, publish runnable bundles, and update retained installations.

| Paths                                                       | Responsibility                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/workbench.mjs`                                         | starts the checked-in Node bundle and identifies the owning project.                                                                                     |
| `bin/workbench`, `bin/workbench.cmd`                        | provide POSIX and Windows launchers.                                                                                                                     |
| `bin/bundle-runtime.cjs`                                    | decompresses and executes artifacts in memory using Node's CommonJS module context.                                                                      |
| `src/distribution-manifest.ts`                              | seals prepared runnable distributions and verifies portable content identities.                                                                          |
| `src/installation-store.ts`                                 | owns immutable versions, owner namespaces, retention roots, and conservative pruning.                                                                    |
| `src/installation-project.ts`                               | registers private checkout profiles and materializes exact dependencies in snapshots.                                                                    |
| `src/installation-dispatch.ts`                              | selects the pinned executable and protects active commands.                                                                                              |
| `src/installation-commands.ts`                              | exposes verified installation, profile inspection, generations, and maintenance.                                                                         |
| `src/update-shared.ts`                                      | prepares shared-version updates with retained generations and rollback evidence.                                                                         |
| `src/update-git.ts`                                         | owns isolated Git preparation and restricts migration patches to managed records and context.                                                            |
| `src/update.ts`                                             | prepares and applies validated Git submodule updates with rollback and recovery evidence.                                                                |
| `src/update-prepare.ts`, `src/sync.ts`                      | validates records and context in the updater’s isolated checkout; `src/sync.ts` coordinates derived files.                                               |
| `bundle`                                                    | contains distributable JavaScript.                                                                                                                       |
| `scripts/build-bundle.mjs`, `scripts/check-bundle.mjs`      | builds the bundle; `scripts/check-bundle.mjs` checks it against TypeScript sources.                                                                      |
| `scripts/bundle-licenses.mjs`                               | retains the license notices of bundled dependencies.                                                                                                     |
| `scripts/bundle-license-overrides.json`, `scripts/licenses` | identifies digest-pinned upstream licenses missing from published packages; `scripts/licenses` retains those license texts.                              |
| `scripts/bundle-options.mjs`                                | shares build settings for compact runnable artifacts and temporary coverage builds.                                                                      |
| `scripts/bundle-artifacts.mjs`                              | selects compression and generates deterministic payloads and their launchers.                                                                            |
| `scripts/package-workbench.mjs`                             | prepares a local runnable distribution without local settings or generated caches.                                                                       |
| `scripts/package-output.mjs`                                | stages distribution output and replaces only owned packages after validation.                                                                            |
| `scripts/check-release.mjs`                                 | verifies the prepared Workbench CLI distribution outside the checkout. Example-owned release verification scripts check their own packages and binaries. |
