import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { managedPreparationFixtures } from "../../fixtures/managed-preparation.mjs";

const { storeProject, run, bootstrapBuilds } = managedPreparationFixtures();

test.skipIf(process.platform !== "linux")(
  "a requested Guix bootstrap refresh rebuilds the verified manager",
  async () => {
    const project = storeProject("guix");
    const prepared = await run(project, "guix");
    expect(prepared.code, prepared.output).toBe(0);
    expect(bootstrapBuilds(prepared)).toHaveLength(1);
    const requested = storeProject("guix");
    requested.env.WORKBENCH_CACHE_HOME = project.env.WORKBENCH_CACHE_HOME;
    requested.env.WORKBENCH_REFRESH_GUIX_BOOTSTRAP = "1";
    const refreshed = await run(requested, "guix");
    expect(refreshed.code, refreshed.output).toBe(0);
    expect(bootstrapBuilds(refreshed)).toHaveLength(1);
  },
);

test.skipIf(process.platform !== "linux")(
  "a custom Guix bootstrap uses its project context and stays separate from the shared image",
  async () => {
    const project = storeProject("guix");
    const recipe = join(project.root, ".devcontainer/guix/Dockerfile");
    writeFileSync(recipe, readFileSync(recipe, "utf8") + "\n# Customized build context\n");
    const custom = await run(project, "guix");
    expect(custom.code, custom.output).toBe(0);
    expect(bootstrapBuilds(custom).at(-1)?.args.at(-1)).toBe(project.root);
    expect(bootstrapBuilds(custom).at(-1)?.args).not.toContain("--label");
  },
);
