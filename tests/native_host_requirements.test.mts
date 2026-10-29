import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeHostLanguages, nativeHostRequirements } from "../scripts/native-host-requirements.mjs";

test("Windows Go checks retain the compiler provided by their host SDK preparation", () => {
  const windows = nativeHostRequirements(["go"], "win32");
  expect(windows.commands).toEqual(["gcc"]);
  expect(windows.packages).toContain("mingw-w64-ucrt-x86_64-gcc");
  for (const platform of ["linux", "darwin"] as const) {
    expect(nativeHostRequirements(["go"], platform).commands).toEqual([]);
    expect(nativeHostRequirements(["go"], platform).packages).toEqual([]);
  }
  expect(nativeHostRequirements(["typescript"], "win32").commands).toEqual([]);
});

test("host requirements preserve native library preparation and explicit Rust linker selection", () => {
  for (const language of ["ruby", "php"]) {
    expect(nativeHostRequirements([language], "linux").packages).toContain("build-essential");
    const mac = nativeHostRequirements([language], "darwin");
    expect(mac.packages).toEqual(expect.arrayContaining(mac.pkgConfigPackages));
    expect(nativeHostRequirements([language], "win32").packages).toContain("make");
  }
  expect(nativeHostRequirements(["rust"], "win32").msvcLinker).toBe(true);
  expect(nativeHostRequirements(["rust"], "linux").msvcLinker).toBe(false);
});

test("host preparation discovers all selected roots and the supported runtime override", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-host-requirements-"));
  try {
    const go = join(root, "go");
    const rust = join(root, "rust");
    mkdirSync(go);
    mkdirSync(rust);
    writeFileSync(join(go, ".go-version"), "fixture");
    writeFileSync(join(rust, "rust-toolchain.toml"), "fixture");
    expect(nativeHostLanguages([go, rust], "ruby").sort()).toEqual(["go", "ruby", "rust"]);
    expect(nativeHostLanguages([], "php")).toEqual(["php"]);
    expect(nativeHostLanguages([], "go")).toEqual([]);
    expect(nativeHostRequirements([], "freebsd").packages).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only projects declaring browser checks require Linux browser libraries", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-browser-host-"));
  try {
    expect(nativeHostLanguages([root])).toEqual([]);
    writeFileSync(join(root, ".tool-versions"), "# chromium-headless-shell is not enabled\nshfmt 3.14.1\n");
    expect(nativeHostLanguages([root])).toEqual([]);
    writeFileSync(join(root, ".tool-versions"), "  chromium-headless-shell\t156.0.8078.4 # pinned engine\n");
    expect(nativeHostLanguages([root])).toEqual(["browser"]);
    expect(nativeHostRequirements(["browser"], "linux").packages).toEqual(
      expect.arrayContaining(["libnss3", "libgbm1", "fonts-liberation"]),
    );
    for (const platform of ["darwin", "win32"] as const)
      expect(nativeHostRequirements(["browser"], platform).packages).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
