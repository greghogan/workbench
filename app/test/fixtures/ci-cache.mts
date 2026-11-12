import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

export function ciCacheFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function fixture() {
    const path = mkdtempSync(join(tmpdir(), "workbench-ci-cache-"));
    temporary.push(path);
    return path;
  }
  return fixture;
}
