import { required } from "../../src/invariants.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { collectionOriginals } from "../../src/collection-git.ts";
import { installSelectedCollections } from "../../src/collection-install.ts";
import { readConfig } from "../../src/core.ts";
import { consumer, distribution, provider } from "./adoption.mjs";

/** Each test file owns its fixture directories, environment overrides, and mocks. */
export function collectionFixture() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function fixture() {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await consumer();
    temporary.push(root);
    return root;
  }
  return { fixture, temporary };
}

export const adopt = (root: string, source: ReturnType<typeof provider>, scope = "project") =>
  installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], {
    scope,
    ...(scope === "project" ? { commit: source.commit } : {}),
  });
export const working = (root: string, name = "company", number = "00") =>
  join(root, `workbench/collections/${name}/decisions/ADR-${number}.md`);
export const original = (root: string, name = "company") =>
  required(
    collectionOriginals(
      root,
      required(
        required(
          required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
          "Expected fixture value: readConfig(root).collections.sources",
        ).find((pin) => pin.id === name),
        "Collection fixture pin",
      ),
    ).files.get("workbench/decisions/ADR-00.md"),
    "Original collection decision",
  );
export const options = (source: ReturnType<typeof provider>) => ({
  commit: source.commit,
  sha256: source.pin.sha256,
  visibility: source.pin.visibility,
});
