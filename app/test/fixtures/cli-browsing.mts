import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, vi } from "vitest";
import { setupProject } from "../../src/cli/project-setup.js";
import { synchronize } from "../../src/core/records/sync.ts";

export const distribution = resolve(import.meta.dirname, "../../..");

afterEach(() => vi.unstubAllEnvs());

interface CliFixture {
  root: string;
  temporary: string;
  run: (...args: string[]) => string;
  runAt: (cwd: string, ...args: string[]) => string;
  fail: (...args: string[]) => string;
}
export async function fixture(action: (fixture: CliFixture) => void | Promise<void>) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const temporary = mkdtempSync(join(tmpdir(), "workbench-cli-"));
  vi.stubEnv("WORKBENCH_DATA_HOME", join(temporary, "data/workbench"));
  const root = join(temporary, "demo");
  mkdirSync(root);
  const invokeAt = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
      },
    });
  const runAt = (cwd: string, ...args: string[]) => {
    const result = invokeAt(cwd, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const run = (...args: string[]) => runAt(root, ...args);
  const fail = (...args: string[]) => {
    const result = invokeAt(root, ...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    await setupProject(root, "demo");
    copyFileSync(
      resolve(import.meta.dirname, "../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    synchronize(root);
    await action({ root, temporary, run, runAt, fail });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function snapshot(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), readFileSync(path, "utf8")];
      }),
  );
}
