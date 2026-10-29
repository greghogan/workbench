import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertNativeCoverageScope, nativeCoverageSources } from "../scripts/native-coverage.mjs";

test("coverage source selection resolves filesystem aliases and rejects fallback to test programs", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-coverage-sources-"));
  try {
    const real = join(root, "source space 文"),
      alias = join(root, "alias"),
      driver = join(root, "driver.c");
    mkdirSync(real);
    writeFileSync(join(real, "count.c"), "int count(void) { return 1; }\n");
    writeFileSync(driver, "int main(void) { return 0; }\n");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const canonical = realpathSync.native(join(real, "count.c")),
      logical = join(alias, "count.c");
    expect(nativeCoverageSources([logical, canonical])).toEqual([canonical]);
    expect(() => {
      assertNativeCoverageScope([canonical], [logical]);
    }).not.toThrow();
    expect(() => {
      assertNativeCoverageScope([logical], [canonical]);
    }).not.toThrow();
    expect(() => {
      assertNativeCoverageScope([canonical, driver], [logical]);
    }).toThrow(/outside the requested/);
    expect(() => {
      assertNativeCoverageScope([], [logical]);
    }).toThrow(/mapped production sources/);
    expect(() => {
      assertNativeCoverageScope([canonical], []);
    }).toThrow(/mapped production sources/);
    expect(() => nativeCoverageSources([join(real, "missing.c")])).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
