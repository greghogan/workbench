import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { miriToolchain, miriToolchainFile, runMiri } from "../src/miri.ts";
import { nativeEnvironment } from "../src/native-tools.ts";
import { nativeTools } from "../src/native-assets.ts";

let temporary: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("a supplementary Miri pin preserves the normal compiler and rejects floating or incomplete declarations", () => {
  temporary = mkdtempSync(join(tmpdir(), "workbench-miri-"));
  const root = join(temporary, "root");
  mkdirSync(root);
  expect(miriToolchain(root)).toBeUndefined();
  expect(() => {
    runMiri(root, ["test"]);
  }).toThrow(/Miri needs rust-toolchain-miri.toml/);
  const file = join(root, miriToolchainFile);
  const valid = '[toolchain]\nchannel="nightly-2026-10-04"\nprofile="minimal"\ncomponents=["miri", "rust-src"]\n';
  writeFileSync(file, valid);
  writeFileSync(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel="1.99.0"\n');
  vi.stubEnv("RUSTUP_TOOLCHAIN", "user-default");
  expect(nativeTools(root)).toEqual([
    { name: "rust", version: "1.99.0", source: "rust-toolchain.toml" },
    { name: "miri", version: "nightly-2026-10-04", source: miriToolchainFile },
  ]);
  expect(nativeEnvironment(root, resolve(import.meta.dirname, "..")).RUSTUP_TOOLCHAIN).toBe("1.99.0");
  expect(process.env.RUSTUP_TOOLCHAIN).toBe("user-default");
  vi.stubEnv("IN_NIX_SHELL", "pure");
  expect(() => {
    runMiri(root, ["test"]);
  }).toThrow(/separately from Guix\/Nix/);
  for (const channel of ["nightly", "stable", "nightly-2026-02-30", "nightly-2026-13-01"]) {
    writeFileSync(file, valid.replace("nightly-2026-10-04", channel));
    expect(() => nativeTools(root)).toThrow(/dated nightly/);
  }
  for (const text of [
    valid.replace('"miri", ', ""),
    valid.replace(', "rust-src"', ""),
    valid.replace('"minimal"', '"default"'),
    `${valid}path="/unreviewed/toolchain"\n`,
  ]) {
    writeFileSync(file, text);
    expect(() => miriToolchain(root)).toThrow(/components including miri and rust-src/);
  }
});
