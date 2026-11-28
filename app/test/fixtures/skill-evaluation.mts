import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { gitNullConfiguration } from "../../src/core/runtime/windows-host.ts";

export function skillEvaluationFixtures() {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  return function fixture() {
    const temporary = mkdtempSync(join(tmpdir(), "workbench-skill-evaluation-"));
    directories.push(temporary);
    const root = join(temporary, "project");
    mkdirSync(root);
    return {
      root,
      env: {
        ...process.env,
        WORKBENCH_CONFIG_HOME: join(temporary, "user"),
        WORKBENCH_CACHE_HOME: join(temporary, "cache"),
        WORKBENCH_DATA_HOME: join(temporary, "data"),
        WORKBENCH_STATE_HOME: join(temporary, "state"),
        GIT_CONFIG_GLOBAL: gitNullConfiguration,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    };
  };
}
