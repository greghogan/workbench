import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")("cleanup unlinks an artifact symlink without following it", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-clean-link-"));
  try {
    const project = join(root, "project");
    const external = join(root, "external");
    mkdirSync(project);
    mkdirSync(external);
    writeFileSync(join(external, "keep"), "fixture");
    symlinkSync(external, join(project, "build"));
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../../../../scripts/clean.mjs"), "build"], {
      cwd: project,
    });
    expect(existsSync(join(project, "build"))).toBe(false);
    expect(existsSync(join(external, "keep"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
