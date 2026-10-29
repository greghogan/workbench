import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { distribution } from "./adoption.mjs";

export const pin = { repository: "https://forge.example/team/workbench.git", revision: "a".repeat(40) };

export function installationFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-launcher-")));
    temporary.push(root);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.stubEnv("WORKBENCH_DATA_HOME", join(root, "data/workbench"));
    vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config/workbench"));
    return root;
  }
  return { fixture, temporary };
}
